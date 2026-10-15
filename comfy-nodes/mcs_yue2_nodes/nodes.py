import contextlib
import logging
import os
import re
import shutil
import struct
import tempfile
import time
import unicodedata
import warnings

import numpy as np
import torch

import comfy.model_management
import folder_paths


def _single_item(audio, node: str) -> torch.Tensor:
    """Return waveform[0] of an AUDIO, refusing batches (the app always sends batch 1)."""
    waveform = audio["waveform"]
    if waveform.shape[0] != 1:
        raise ValueError(f"{node} はバッチサイズ 1 の音声にのみ対応しています（受け取ったバッチサイズ: {waveform.shape[0]}）。")
    return waveform[0]


def _require_finite(t: torch.Tensor, what: str) -> None:
    # Same guard as the official YuE2 pipeline (pipeline.py: "VAE produced non-finite audio").
    if not bool(torch.isfinite(t).all()):
        raise ValueError(f"{what}に非有限値（NaN/Inf）が含まれています。生成または読み込みをやり直してください。")


def _write_wav_float32(path: str, samples: np.ndarray, sample_rate: int) -> None:
    """Write a WAVE_FORMAT_IEEE_FLOAT (32-bit float) WAV file. samples: (channels, frames)."""
    channels, frames = samples.shape
    # One interleaved float32 copy, written through a memoryview (no extra bytes object).
    interleaved = np.ascontiguousarray(samples.T, dtype=np.float32)
    nbytes = interleaved.nbytes
    bits = 32
    block_align = channels * bits // 8
    byte_rate = sample_rate * block_align
    # WAVE_FORMAT_EXTENSIBLE is not needed for <= 2 channels; plain format tag 3 = IEEE float.
    fmt = struct.pack("<HHIIHH", 3, channels, sample_rate, byte_rate, block_align, bits)
    fact = struct.pack("<I", frames)
    riff_size = 4 + (8 + len(fmt)) + (8 + len(fact)) + (8 + nbytes) + (nbytes % 2)
    if riff_size >= 2**32:
        raise ValueError("音声が長すぎるため WAV（上限 4 GB）に保存できません。")
    with open(path, "wb") as f:
        f.write(b"RIFF")
        f.write(struct.pack("<I", riff_size))
        f.write(b"WAVE")
        f.write(b"fmt ")
        f.write(struct.pack("<I", len(fmt)))
        f.write(fmt)
        f.write(b"fact")
        f.write(struct.pack("<I", len(fact)))
        f.write(fact)
        f.write(b"data")
        f.write(struct.pack("<I", nbytes))
        f.write(memoryview(interleaved))
        if nbytes % 2:
            f.write(b"\x00")


class MCS_SaveAudioWav:
    """Save AUDIO as 32-bit float WAV without any quantization (ComfyUI's SaveAudio writes 16-bit FLAC).

    Like the official YuE2 pipeline (pipeline.py: isfinite check, then clamp(-1, 1), then a FLOAT WAV),
    non-finite audio is rejected and samples are clamped to [-1, 1].
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "filename_prefix": ("STRING", {"default": "audio/mcs"}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "MCS YuE2"

    def save(self, audio, filename_prefix="audio/mcs"):
        waveform = audio["waveform"]  # (batch, channels, frames)
        sample_rate = int(audio["sample_rate"])
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory()
        )
        _require_finite(waveform, "保存する音声")
        results = []
        for i in range(waveform.shape[0]):
            wav = waveform[i].detach().cpu().float().clamp(-1.0, 1.0).numpy()
            name = f"{filename}_{counter:05}_.wav"
            _write_wav_float32(os.path.join(full_output_folder, name), wav, sample_rate)
            results.append({"filename": name, "subfolder": subfolder, "type": "output"})
            counter += 1
        return {"ui": {"audio": results}}


class MCS_AudioInfo:
    """Report duration / sample rate / channels / peak / RMS of an AUDIO (text output for the app).

    peak is measured before any clamping; clipped_samples counts the samples MCS_SaveAudioWav clamps.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"audio": ("AUDIO",)}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("info_json",)
    FUNCTION = "info"
    OUTPUT_NODE = True
    CATEGORY = "MCS YuE2"

    def info(self, audio):
        import json

        w = _single_item(audio, "MCS_AudioInfo").detach().cpu().float()
        _require_finite(w, "音声")  # NaN would make info_json invalid JSON for the app
        sr = int(audio["sample_rate"])
        peak = float(w.abs().max()) if w.numel() else 0.0
        rms = float(torch.sqrt((w**2).mean())) if w.numel() else 0.0
        payload = {
            "seconds": round(w.shape[-1] / sr, 3),
            "sample_rate": sr,
            "channels": int(w.shape[0]),
            "peak": round(peak, 5),
            "rms": round(rms, 5),
            "clipped_samples": int((w.abs() > 1.0).sum()),
        }
        text = json.dumps(payload)
        return {"ui": {"text": [text]}, "result": (text,)}


NODE_CLASS_MAPPINGS = {
    "MCS_SaveAudioWav": MCS_SaveAudioWav,
    "MCS_AudioInfo": MCS_AudioInfo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MCS_SaveAudioWav": "MCS · Save Audio (32-bit float WAV)",
    "MCS_AudioInfo": "MCS · Audio Info",
}


# ---------------------------------------------------------------------------------------------
# Vocal separation (python-audio-separator, BS-Roformer / MelBand-Roformer / Demucs)
# ---------------------------------------------------------------------------------------------

SEPARATION_MODELS = [
    "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "model_bs_roformer_ep_368_sdr_12.9628.ckpt",
    "vocals_mel_band_roformer.ckpt",
    "melband_roformer_big_beta4.ckpt",
    "htdemucs_ft.yaml",
]

# Per-run work folders (input.wav + stems). separate() removes its own in `finally`, which a killed ComfyUI
# (the app stops it with taskkill /F) never reaches: folders older than any separation are swept later.
_SEP_WORK_PREFIX = "mcs_sep_"
_SEP_WORK_STALE_SECONDS = 12 * 3600


def _sep_work_root() -> str:
    """Where the work folders go: MCS_TEMP_DIR when set (and creatable), else the system temp folder."""
    root = os.environ.get("MCS_TEMP_DIR")
    if root:
        try:
            os.makedirs(root, exist_ok=True)
            return root
        except OSError:
            pass
    return tempfile.gettempdir()


def _sweep_stale_work_dirs(root=None, max_age=_SEP_WORK_STALE_SECONDS) -> int:
    """Remove mcs_sep_* folders older than max_age seconds (left behind by a killed run). Only old ones: another
    ComfyUI using the same root may be separating right now. Never raises; returns how many were removed."""
    removed = 0
    try:
        root = root or _sep_work_root()
        now = time.time()
        with os.scandir(root) as entries:
            for e in entries:
                try:
                    if e.name.startswith(_SEP_WORK_PREFIX) and e.is_dir(follow_symlinks=False) and now - e.stat(follow_symlinks=False).st_mtime > max_age:
                        shutil.rmtree(e.path, ignore_errors=True)
                        removed += 1
                except OSError:
                    pass
    except OSError:
        pass
    return removed


_sweep_stale_work_dirs()  # once when ComfyUI loads the pack

# 4-stem models whose non-vocal stems are summed into the instrumental. audio-separator peak-normalizes
# every stem on its own before writing it (common_separator.py write_audio_*: spec_utils.normalize with
# normalization_threshold, default 0.9), which would change the balance of the summed stems. For these
# models the threshold is 1.0 (the largest allowed) and the input is scaled down to _MULTI_STEM_INPUT_PEAK
# (undone on the stems), so no stem reaches 1.0 even for inputs above 0 dBFS (decoded lossy files) or stems
# that partly cancel in the mix: the stems are written unscaled. Demucs normalizes its input by its standard
# deviation, so the scaling is lossless. _limit_peak then applies the library's 0.9 rule to the summed result.
_MULTI_STEM_MODELS = ("htdemucs_ft.yaml",)
_MULTI_STEM_INPUT_PEAK = 0.25
_STEM_PEAK = 0.9  # audio-separator's default normalization_threshold
# 5.1 downmix (ITU-R BS.775: C and the surrounds at -3 dB, LFE dropped, as ffmpeg -ac 2) in FFmpeg's channel
# order FL FR FC LFE BL/SL BR/SR, which LoadAudio keeps. The separation models take mono or stereo only.
_DOWNMIX_51 = 0.5**0.5


def _separation_model_dir():
    d = os.environ.get("MCS_SEPARATION_MODELS_DIR")
    if d:
        os.makedirs(d, exist_ok=True)
        return d
    d = os.path.join(folder_paths.models_dir, "audio_separator")
    os.makedirs(d, exist_ok=True)
    return d


def _ensure_ffmpeg_on_path():
    d = os.environ.get("MCS_FFMPEG_DIR")
    if d and os.path.isdir(d) and d not in os.environ.get("PATH", ""):
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def _apply_comfy_device(sep):
    """audio-separator picks its own device (CUDA whenever available). Follow ComfyUI's choice instead
    (--cpu, the selected CUDA device). Must run before load_model, which hands torch_device to the model."""
    try:
        dev = comfy.model_management.get_torch_device()
    except Exception:
        return
    if dev.type == "cpu":
        sep.torch_device = torch.device("cpu")
        sep.onnx_execution_provider = ["CPUExecutionProvider"]
    elif dev.type == "cuda" and getattr(getattr(sep, "torch_device", None), "type", None) == "cuda":
        # Only a CUDA index other than the current device is applied. The library compares torch_device
        # with torch.device("cuda") for equality before it empties the CUDA cache (common_separator.py
        # clear_gpu_cache), so swapping in ComfyUI's cuda:0 would silently disable that; separate()'s
        # finally block still runs soft_empty_cache as a backstop.
        try:
            current = torch.cuda.current_device()
        except Exception:
            current = None
        if dev.index is not None and dev.index != current:
            sep.torch_device = dev


def _separator_kwargs(model_filename: str) -> dict:
    """Extra Separator arguments. use_soundfile: the stems are written by soundfile with the input's FLOAT
    subtype (lossless); the default pydub writer quantizes every stem to 16 bit before ffmpeg writes it."""
    kwargs = {"use_soundfile": True}
    if model_filename in _MULTI_STEM_MODELS:
        kwargs["normalization_threshold"] = 1.0
    return kwargs


_PART_SUFFIX = ".mcs_part"  # not the setup's ".part" (a resumable download of the default checkpoint)
_DOWNLOAD_CHUNK = 1 << 16


def _expected_length(headers):
    """Content-Length of a body that is not content-encoded, else None (requests decodes gzip, so the count differs)."""
    if (headers.get("content-encoding") or "identity").strip().lower() != "identity":
        return None
    try:
        n = int(headers.get("content-length"))
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


class _DownloadStatusError(RuntimeError):
    """A non-200 response: a RuntimeError like the library's own, so download_model_files still tries its second repository."""

    def __init__(self, url: str, status):
        super().__init__(f"Failed to download file from {url}, response code: {status}")
        self.url = url
        self.status = status


class _IncompleteDownloadError(OSError):
    """A body that does not match its Content-Length (the connection closed early)."""


def _download_atomic(url: str, output_path: str, failures: list) -> None:
    """Replaces audio-separator's Separator.download_file_if_not_exists (0.47.0) for one Separator. The library's
    version streams straight into the final path and skips any file that exists, so a download cut off (network
    error, ComfyUI stopped by the app) left a truncated model, config or download_checks.json that failed every later
    run. Same contract: an existing file is kept, a non-200 status raises RuntimeError (the library then tries its
    second repository). The body goes to <path>.mcs_part, renamed when complete and removed on any error; キャンセル
    (ComfyUI's interrupt) stops it. Each failure other than the interrupt is appended to `failures` as (error, path,
    saving): saving is whether a file operation failed (open, write, close or rename of <path>.mcs_part), not the
    request or the stream - requests itself raises a plain OSError too (a CA bundle path that does not exist)."""
    if os.path.isfile(output_path):
        return
    import requests

    part = output_path + _PART_SUFFIX
    logging.info("MCS_VocalSeparate: 分離モデルのファイルを取得しています: %s", url)
    saving = False
    try:
        response = requests.get(url, stream=True, timeout=300)
        try:
            if response.status_code != 200:
                raise _DownloadStatusError(url, response.status_code)
            expected = _expected_length(response.headers)
            written = 0
            saving = True
            with open(part, "wb") as f:
                saving = False
                for chunk in response.iter_content(chunk_size=_DOWNLOAD_CHUNK):
                    comfy.model_management.throw_exception_if_processing_interrupted()
                    saving = True
                    f.write(chunk)
                    saving = False
                    written += len(chunk)
                saving = True  # closing writes what is still buffered
            saving = False
            if expected is not None and written != expected:
                raise _IncompleteDownloadError(f"incomplete download of {url}: {written} of {expected} bytes")
        finally:
            response.close()
        saving = True
        os.replace(part, output_path)
    except BaseException as e:
        try:
            os.remove(part)
        except OSError:
            pass
        if isinstance(e, Exception) and not isinstance(e, comfy.model_management.InterruptProcessingException):
            failures.append((e, output_path, saving))
        raise


def _download_failure_error(model_filename: str, failed: str, e: Exception, saving: bool) -> RuntimeError:
    """What to raise for the failed download of `failed`. The app shows only this message (not the chained cause),
    so it keeps the error text, and the advice follows where it failed (see _download_atomic): an OSError of a file
    operation (`saving`) is the folder (disk full, read-only, a file locked by antivirus), a non-200 status the server
    (checking the connection does not help), anything else the connection - the request, the stream or a short body,
    whatever type requests raised."""
    name = os.path.basename(failed)
    head = f"分離モデル「{model_filename}」のファイル"
    if isinstance(e, _DownloadStatusError):
        return RuntimeError(
            f"{head}を取得できませんでした（{name}: {e.url} の応答コード {e.status}）。"
            "配布元のサーバーがファイルを返しませんでした。時間をおいてもう一度実行するか、別の分離モデルを選んでください。"
        )
    detail = str(e).strip() or type(e).__name__
    if len(detail) > 200:
        detail = detail[:200] + "…"
    if saving and isinstance(e, OSError):
        return RuntimeError(
            f"{head}（{name}）を保存できませんでした（{detail}）。"
            f"ディスクの空き容量と {os.path.dirname(failed)} への書き込み権限を確認して、もう一度実行してください。"
        )
    return RuntimeError(f"{head}を取得できませんでした（{name}: {detail}）。インターネット接続を確認して、もう一度実行してください。")


def _drop_unreadable_download_checks(model_dir: str) -> None:
    """audio-separator reads download_checks.json on every load_model and never downloads it again while it exists;
    one cut off by an earlier build failed every model with a JSONDecodeError. Removed, so it is fetched again."""
    import json

    path = os.path.join(model_dir, "download_checks.json")
    try:
        with open(path, encoding="utf-8") as f:
            json.load(f)
    except ValueError:  # JSONDecodeError, UnicodeDecodeError: what the library's own json.load fails on
        try:
            os.remove(path)
        except OSError:
            pass
    except OSError:
        pass


def _new_separator(model_filename: str, output_dir: str):
    """A new Separator with the model loaded, writing to output_dir. Built for every run: the separator lives
    outside ComfyUI model management (/free cannot release it), so MCS_VocalSeparate drops it afterwards."""
    _ensure_ffmpeg_on_path()  # Separator.__init__ still checks for ffmpeg on PATH
    try:
        from audio_separator.separator import Separator
    except ImportError as e:
        raise RuntimeError(
            "ボーカル分離には audio-separator が必要です。セットアップで「audio-separator（ボーカル分離ライブラリ）」を導入してください。"
        ) from e
    model_dir = _separation_model_dir()
    sep = Separator(log_level=30, model_file_dir=model_dir, output_dir=output_dir, output_format="WAV", **_separator_kwargs(model_filename))
    _apply_comfy_device(sep)
    # The library fetches the model, its config and download_checks.json on first use through
    # self.download_file_if_not_exists: an instance attribute replaces it with the atomic download.
    failures = []
    sep.download_file_if_not_exists = lambda url, output_path: _download_atomic(url, output_path, failures)
    _drop_unreadable_download_checks(model_dir)
    try:
        sep.load_model(model_filename=model_filename)
    except Exception as e:
        failure = next((f for f in failures if f[0] is e), None)
        if failure is None:
            raise
        _, failed, saving = failure
        raise _download_failure_error(model_filename, failed, e, saving) from e
    return sep


def _separator_exit_error(model_filename: str, loaded: bool, e: SystemExit) -> BaseException:
    """What to raise for a SystemExit from audio-separator. 0.47.0 ends a failed Roformer load with sys.exit(1)
    (mdxc_separator.py load_model catches the RuntimeError of a corrupt or truncated checkpoint or of a CUDA OOM).
    SystemExit is no Exception: it passes ComfyUI's error handling and silently ends its prompt worker thread, so
    no later prompt would run. A CUDA OOM becomes an OutOfMemoryError (ComfyUI then unloads its models), anything
    else a RuntimeError naming the file to delete."""
    ctx = e.__context__
    while ctx is not None:
        if isinstance(ctx, torch.cuda.OutOfMemoryError) or "out of memory" in str(ctx).lower():
            return torch.cuda.OutOfMemoryError(
                f"分離モデル「{model_filename}」の実行に必要な VRAM が足りません。LLM を停止するなどして VRAM を空けてから、もう一度実行してください。"
            )
        ctx = ctx.__context__
    if loaded:
        return RuntimeError(f"ボーカル分離が異常終了しました（audio-separator の終了コード: {e.code}）。")
    return RuntimeError(
        f"分離モデル「{model_filename}」を読み込めませんでした（ファイルの破損や取得の中断が考えられます）。"
        f"{os.path.join(_separation_model_dir(), model_filename)} を削除してから、もう一度実行してください（次の実行で取得し直します）。"
    )


@contextlib.contextmanager
def _tqdm_checks_interrupt():
    """While it is active, every step of a tqdm loop checks ComfyUI's interrupt flag, so キャンセル stops a separation
    within one chunk. audio-separator's chunk loops (Roformer: mdxc_separator demix, Demucs: apply_model) are plain
    tqdm loops without a hook, and ComfyUI checks the flag only between nodes. Patched on the tqdm class for the call
    only (ComfyUI runs one prompt at a time)."""
    try:
        from tqdm.std import tqdm as bar
    except ImportError:
        yield
        return
    orig = bar.__iter__
    check = comfy.model_management.throw_exception_if_processing_interrupted

    def checked(self):
        it = orig(self)
        try:
            for item in it:
                check()
                yield item
        finally:
            it.close()

    bar.__iter__ = checked
    try:
        yield
    finally:
        bar.__iter__ = orig


def _separation_input(w: torch.Tensor) -> torch.Tensor:
    """(channels, frames) the separation models accept: mono and stereo as they are, 5.1 downmixed to stereo; other
    layouts are refused (LoadAudio keeps every channel but not the layout, and the models assert 1 or 2 channels)."""
    ch = w.shape[0]
    if ch <= 2:
        return w
    if ch == 6:
        return torch.stack((w[0] + _DOWNMIX_51 * (w[2] + w[4]), w[1] + _DOWNMIX_51 * (w[2] + w[5])))
    raise ValueError(f"ボーカル分離はモノラル・ステレオ・5.1ch の音源に対応しています（この音源は {ch}ch）。ステレオに変換したファイルを選択してください。")


def _load_wav_tensor(path: str):
    try:
        import soundfile as sf
    except ImportError as e:
        raise RuntimeError("soundfile がありません（audio-separator と一緒に導入されます）。audio-separator を導入し直してください。") from e

    data, sr = sf.read(path, dtype="float32", always_2d=True)  # (frames, channels)
    return torch.from_numpy(data.T.copy()).unsqueeze(0), int(sr)  # (1, channels, frames)


# audio-separator names every stem "<input base>_(<stem>)_<model name>.<ext>" (common_separator.py
# get_stem_output_path). The model name may itself contain "vocals", so only the "(<stem>)" part is used.
_STEM_RE = re.compile(r"_\(([^)]+)\)_")
_VOCAL_STEMS = ("vocals", "vocal")


def _stem_label(path: str) -> str:
    m = _STEM_RE.search(os.path.basename(path))
    return m.group(1).strip().lower() if m else ""


def _classify_stems(paths: list) -> tuple:
    """Return (vocals_path, [other stem paths]).

    2-stem models give vocals + instrumental / other; 4-stem Demucs gives bass / drums / other / vocals,
    whose non-vocal stems are mixed back into the instrumental by _mix_stems.
    """
    labels = [_stem_label(p) for p in paths]
    vocals = [p for p, label in zip(paths, labels) if label in _VOCAL_STEMS]
    others = [p for p, label in zip(paths, labels) if label not in _VOCAL_STEMS]
    if len(vocals) != 1 or not others:
        found = ", ".join(label or os.path.basename(p) for p, label in zip(paths, labels)) or "なし"
        raise RuntimeError(f"分離結果のステム構成が想定外です（検出したステム: {found}）。")
    return vocals[0], others


def _limit_peak(w: torch.Tensor, max_peak: float = _STEM_PEAK) -> torch.Tensor:
    """Scale down to max_peak when the peak exceeds it (spec_utils.normalize without amplification)."""
    peak = float(w.abs().max()) if w.numel() else 0.0
    return w * (max_peak / peak) if peak > max_peak else w


def _mix_stems(paths: list) -> tuple:
    """Load the stems and sum them (demucs sources sum to the mix). Returns ((1, ch, frames), sr).

    The stems are as audio-separator wrote them (see _MULTI_STEM_MODELS for its per-stem normalization);
    the caller limits the peak of the sum.
    """
    mix, sr = _load_wav_tensor(paths[0])
    for p in paths[1:]:
        w, sr_w = _load_wav_tensor(p)
        if sr_w != sr or w.shape[1] != mix.shape[1]:
            raise RuntimeError(f"分離ステムの形式が一致しません（{sr} Hz/{mix.shape[1]}ch と {sr_w} Hz/{w.shape[1]}ch）。")
        n = min(mix.shape[-1], w.shape[-1])
        mix = mix[..., :n] + w[..., :n]
    return mix, sr


class MCS_VocalSeparate:
    """Split AUDIO into vocals and instrumental with python-audio-separator (GPU)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "model": (SEPARATION_MODELS, {"default": SEPARATION_MODELS[0]}),
            }
        }

    RETURN_TYPES = ("AUDIO", "AUDIO")
    RETURN_NAMES = ("vocals", "instrumental")
    FUNCTION = "separate"
    CATEGORY = "MCS YuE2"

    def separate(self, audio, model):
        import gc

        w = _single_item(audio, "MCS_VocalSeparate").detach().cpu().float()
        _require_finite(w, "分離する音声")  # no clamp: audio-separator reads float input as is
        w = _separation_input(w)
        gain = 1.0
        if model in _MULTI_STEM_MODELS:
            peak = float(w.abs().max()) if w.numel() else 0.0
            if peak > _MULTI_STEM_INPUT_PEAK:
                gain = _MULTI_STEM_INPUT_PEAK / peak
                w = w * gain
        sample_rate = int(audio["sample_rate"])
        root = _sep_work_root()
        _sweep_stale_work_dirs(root)
        work = tempfile.mkdtemp(prefix=_SEP_WORK_PREFIX, dir=root)
        sep = None
        paths = []
        try:
            src = os.path.join(work, "input.wav")
            _write_wav_float32(src, w.numpy(), sample_rate)
            # Separator.__init__ installs a process-wide warnings.filterwarnings("ignore") (log_level above
            # DEBUG). Scoped here, the library stays quiet while it loads and separates, and every other
            # warning of the ComfyUI process is reported again afterwards.
            with warnings.catch_warnings():
                try:
                    sep = _new_separator(model, work)
                    # キャンセル: checked after the load and at every chunk of the separation
                    comfy.model_management.throw_exception_if_processing_interrupted()
                    with _tqdm_checks_interrupt():
                        outputs = sep.separate(src)
                except SystemExit as e:
                    raise _separator_exit_error(model, sep is not None, e) from e
            # audio-separator 0.47.0 writes the stems to model_instance.output_dir (= work) and returns names.
            out_dir = getattr(getattr(sep, "model_instance", None), "output_dir", None) or work
            paths = [name if os.path.isabs(name) else os.path.join(out_dir, name) for name in outputs]
            vocals_path, other_paths = _classify_stems(paths)
            v, sr_v = _load_wav_tensor(vocals_path)
            i, sr_i = _mix_stems(other_paths)
            if gain != 1.0:  # back to the input's level (see _MULTI_STEM_MODELS)
                v, i = v / gain, i / gain
            # Same output level rule as a single stem (no-op for 2-stem models, which are already <= 0.9);
            # keeps the summed 4-stem instrumental from hard-clipping in MCS_SaveAudioWav.
            v, i = _limit_peak(v), _limit_peak(i)
            return ({"waveform": v, "sample_rate": sr_v}, {"waveform": i, "sample_rate": sr_i})
        finally:
            # The tensors are already in memory; always remove the temp files, also on errors.
            shutil.rmtree(work, ignore_errors=True)
            # The separator lives outside ComfyUI model management, so /free cannot release it.
            # Drop it after every run (the next run reloads the checkpoint from disk). On errors the
            # propagating traceback still references the model / partial GPU tensors; ComfyUI's prompt
            # worker frees them with its next gc.collect() + soft_empty_cache() (main.py prompt_worker).
            sep = None
            gc.collect()
            comfy.model_management.soft_empty_cache()


NODE_CLASS_MAPPINGS["MCS_VocalSeparate"] = MCS_VocalSeparate
NODE_DISPLAY_NAME_MAPPINGS["MCS_VocalSeparate"] = "MCS · Vocal Separation (audio-separator)"


# ---------------------------------------------------------------------------------------------
# Lyrics forced alignment (torchaudio MMS_FA, wav2vec2 CTC) -> line timestamps for synced lyrics
# ---------------------------------------------------------------------------------------------

_aligner_cache = {}

# Emission windows, like the official MMS data_prep (generate_emissions: 30 s windows with context).
# Boundaries are multiples of the wav2vec2 frame hop, so every window starts on the global frame grid.
_ALIGN_SEGMENT_SECONDS = 30
_ALIGN_CONTEXT_SECONDS = 3
_WAV2VEC2_HOP = 320  # 5 * 2**6 samples per frame at 16 kHz (20 ms)


def _feature_hop(model) -> int:
    """Total stride of the wav2vec2 conv feature extractor (320 for MMS_FA)."""
    try:
        hop = 1
        for layer in model.model.feature_extractor.conv_layers:
            hop *= int(layer.conv.stride[0])
        return hop
    except (AttributeError, TypeError):
        return _WAV2VEC2_HOP


def _chunked_emission(model, wav: torch.Tensor, device, hop: int, sample_rate: int,
                      segment_seconds: float = _ALIGN_SEGMENT_SECONDS, context_seconds: float = _ALIGN_CONTEXT_SECONDS):
    """Run the CTC model window by window. wav: (1, samples) on CPU -> emission (1, frames, tokens) on device.

    Each window [s, e) is run with up to `context` samples on both sides; the context frames are dropped.
    A tail shorter than the context is merged into the last window, so every inner window keeps its full
    right context and the frame count equals a single pass (audio up to segment + context is one pass).
    """
    segment = max(hop, int(segment_seconds * sample_rate) // hop * hop)
    # At least one hop: an inner window needs receptive field - hop (80 samples for wav2vec2) of right
    # context, otherwise it yields one frame less and the later timings drift.
    context = max(hop, int(context_seconds * sample_rate) // hop * hop)
    n = wav.shape[1]
    chunks = []
    s = 0
    while s < n:
        # キャンセル: ComfyUI checks its interrupt flag only between nodes, and this is the last node of the alignment
        comfy.model_management.throw_exception_if_processing_interrupted()
        e = min(s + segment, n)
        if n - e < context:
            e = n
        cs = max(0, s - context)
        ce = min(n, e + context)
        out, _ = model(wav[:, cs:ce].to(device))
        skip = (s - cs) // hop
        chunks.append(out[:, skip:] if e == n else out[:, skip:skip + (e - s) // hop])
        s = e
    return torch.cat(chunks, dim=1)


def _fold_latin(s: str) -> str:
    """NFKD with the combining marks removed and curly apostrophes straightened (café -> cafe, ｈｅｌｌｏ -> hello)."""
    s = unicodedata.normalize("NFKD", s).replace("\u2019", "'").replace("\u2018", "'")
    return "".join(c for c in s if not unicodedata.combining(c))


def _latin_tokens(s: str) -> list:
    """Lowercase Latin words of `s` for the CTC dictionary. MMS_FA's dictionary has "'" as a token; keep it
    inside words ("don't"), not at the edges."""
    return [w.strip("'") for w in re.findall(r"[a-z']+", _fold_latin(s).lower()) if w.strip("'")]


def _has_other_letters(s: str) -> bool:
    """True when `s` holds letters that are not Latin after the fold (Hangul, Cyrillic, Greek, Thai, kana, kanji …)."""
    return any(c.isalpha() and not ("a" <= c <= "z") for c in _fold_latin(s).lower())


def _uroman():
    """The cached uroman romanizer (the universal romanization MMS_FA was trained on), or None when the
    optional package is not installed. The import is retried until it succeeds, so a package added by the
    app's setup while ComfyUI runs is picked up on the next run (MCS_AlignLyrics.IS_CHANGED puts the installed
    romanizers into ComfyUI's cache key, so a cached result from before the install is not reused)."""
    rom = _aligner_cache.get("uroman")
    if rom is None:
        try:
            import uroman
        except ImportError:
            return None
        rom = uroman.Uroman()  # loads its data tables (about 1.5 s), hence the cache
        _aligner_cache["uroman"] = rom
    return rom


# Latin letters that NFKD does not decompose, spelled the way uroman romanizes them (Straße -> strasse,
# Ærø -> aeroe, łza -> lza). Only used when uroman is missing; with it these words go through uroman.
_LATIN_EXTRA = str.maketrans({
    "ß": "ss", "ẞ": "ss", "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe", "ø": "oe", "Ø": "oe",
    "ł": "l", "Ł": "l", "đ": "d", "Đ": "d", "ð": "th", "Ð": "th", "þ": "th", "Þ": "th",
    "ı": "i", "ŋ": "ng", "Ŋ": "ng", "ħ": "h", "Ħ": "h",
})


def _romanized_tokens(piece: str, romanized: str, unromanized) -> list:
    """CTC tokens of `romanized` (a romanizer's output for `piece`, or `piece` itself when there is none).
    Letters the romanizer did not know go through uroman when it is installed. Without it, Latin letters NFKD
    cannot fold (ß, æ, ø, ł …) are spelled out with _LATIN_EXTRA and other letters are dropped; a piece that
    lost letters that way is appended to `unromanized` (a list, or None), so the caller can report it."""
    toks = _latin_tokens(romanized)
    if _has_other_letters(romanized):
        rom = _uroman()
        if rom is not None:
            return _latin_tokens(rom.romanize_string(piece))
        spelled = romanized.translate(_LATIN_EXTRA)
        toks = _latin_tokens(spelled)
        if unromanized is not None and (not toks or _has_other_letters(spelled)):
            unromanized.append(piece)
    return toks


# kana, kanji (with 々〆〇 and the compatibility block) and half-width katakana: the characters of a ja run
_JAPANESE_CHAR = re.compile(r"[\u3005-\u3007\u3040-\u30ff\u31f0-\u31ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]")
# What a ja run gives pykakasi (after _kakasi_text). 2.3 has no branch for ヽヾヿ, the small katakana ㇰ-ㇿ, the
# compatibility kanji NFC keeps (﨎, 﨑 …) or the half-width ﾟ, and repeats the previous item after them
# (ありがとうヾ -> ありがとう, ヾ, ありがとう), a word that was never sung.
_KAKASI_RUN = re.compile(r"[\u3005-\u3007\u3040-\u30fc\u3400-\u9fff]+")
_HALFWIDTH_KANA = re.compile(r"[\uff66-\uff9f]+")
_KAKASI_READABLE = str.maketrans("\u31f0\u31f1\u31f2\u31f3\u31f4\u31f5\u31f6\u31f7\u31f8\u31f9\u31fa\u31fb\u31fc\u31fd\u31fe\u31ff\ufa11", "クシストヌハヒフヘホムラリルレロ崎")


def _kakasi_text(run: str) -> str:
    """A ja run with half-width katakana made full-width (ﾊﾟ -> パ, NFKC), the small katakana ㇰ-ㇿ full-size and
    﨑 read as 崎; _KAKASI_RUN leaves out what pykakasi still cannot read (ヽヾヿ, 﨎 …), like an emoji."""
    run = _HALFWIDTH_KANA.sub(lambda m: unicodedata.normalize("NFKC", m.group(0)), run)
    return run.translate(_KAKASI_READABLE)


def _is_latin_letter(ch: str) -> bool:
    """A letter that folds to a-z (ASCII, accented and full-width Latin: é, Ｌ), also the Latin letters NFKD
    cannot fold (ß, æ, ø, ł …, spelled with _LATIN_EXTRA), so a word like Straße stays one latin run."""
    if not ch.isalpha() or _JAPANESE_CHAR.match(ch):
        return False
    folded = _fold_latin(ch).translate(_LATIN_EXTRA).lower()
    return bool(folded) and all("a" <= c <= "z" for c in folded)


_APOSTROPHES = "'\u2019"
# a quote that opens a quoted Latin word ('Hello', ‘Go’, ‛Go’)
_OPENING_QUOTES = "'\u2018\u201b"


def _script_runs(text: str) -> list:
    """Split `text` into (run, kind) pairs, kind "ja" | "latin" | "foreign".

    foreign runs hold letters of scripts other than Japanese and Latin (Hangul, Cyrillic …): pykakasi must not
    see them, it drops what it does not know (사랑해 -> 사/해). latin runs hold Latin words (half- or
    full-width, with inner apostrophes: don't) and the spaces between them; pykakasi would merge a phrase into
    one item and split full-width letters one by one. A quote that opens a quoted Latin word (at the start or
    after a space: 'Hello', ‘Go’) belongs to that word, so its text keeps both quotes as on the en path.
    Everything else (kana, kanji, digits, punctuation, a space after Japanese) goes into ja runs."""
    runs = []
    for i, ch in enumerate(text):
        prev = runs[-1] if runs else None
        in_latin = prev is not None and prev[1] == "latin"
        if _is_latin_letter(ch):
            kind = "latin"
        elif in_latin and (ch.isspace() or (ch in _APOSTROPHES and not prev[0][-1].isspace())):
            kind = "latin"
        elif ch in _OPENING_QUOTES and (i == 0 or text[i - 1].isspace()) and i + 1 < len(text) and _is_latin_letter(text[i + 1]):
            kind = "latin"
        elif ch.isalpha() and not _JAPANESE_CHAR.match(ch) and _has_other_letters(ch):
            kind = "foreign"
        else:
            kind = "ja"
        if prev is not None and prev[1] == kind:
            prev[0] += ch
        else:
            runs.append([ch, kind])
    return [(run, kind) for run, kind in runs]


# Han characters (〇, CJK unified ideographs with extension A, compatibility ideographs, extensions B-G)
_HAN_RUN = re.compile(r"[\u3007\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0003134f]+")


def _romanize_line(text: str, language: str, unromanized=None) -> list:
    """Return a list of (token_for_model, original_word) for one lyric line.

    MMS_FA only knows lowercase Latin letters. Japanese is converted with pykakasi (romaji; Latin words in a
    Japanese line stay one entry per word), Chinese with pypinyin (the reading of a run of hanzi is chosen in
    context, the output is one word per character), Latin text is folded to ASCII (ß, æ, ø, ł … via
    _LATIN_EXTRA when uroman is missing). Every other script (Korean, Cyrillic,
    Greek, Arabic, Thai, Devanagari …, and kana / hanzi while pykakasi / pypinyin are missing) is romanized
    with uroman, the romanizer MMS_FA was trained on, when that optional package is installed. Without it
    such words are dropped as before; a word that yields nothing is appended to `unromanized` when a list
    is given, so the caller can report the skipped lines.
    """
    if language == "ja":
        try:
            import pykakasi
        except ImportError:
            pykakasi = None
        if pykakasi is not None:
            kks = _aligner_cache.get("kakasi")
            if kks is None:
                kks = pykakasi.kakasi()
                _aligner_cache["kakasi"] = kks
            out = []
            text = unicodedata.normalize("NFC", text)  # decomposed が would be read as か
            for run, kind in _script_runs(text):
                if kind == "foreign":
                    toks = _romanized_tokens(run, run, unromanized)
                    if toks:
                        out.append(("".join(toks), run))
                    continue
                if kind == "latin":
                    # One entry per word, like the en path (the word text keeps the full-width letters).
                    for w in re.findall(r"\S+", run):
                        toks = _romanized_tokens(w, w, unromanized)
                        if toks:
                            out.append(("".join(toks), w))
                    continue
                # Only the Japanese characters pykakasi reads go to it: after an emoji, NBSP or half-width ｡､｢｣ it
                # repeats the previous item (「ありがとう😊」 -> ありがとう twice), a word that was never sung. The rest
                # of a ja run (digits, punctuation, symbols) yields no CTC token anyway.
                for item in [x for seg in _KAKASI_RUN.findall(_kakasi_text(run)) for x in kks.convert(seg)]:
                    orig = item["orig"]
                    romaji = item.get("hepburn", "") or ""
                    if "を" in orig or "ヲ" in orig:
                        # を/ヲ is always pronounced "o" (pykakasi gives "wo"), also inside a kana run
                        # (「あなたをまってる」 is one item). は/へ need POS, so they stay "ha"/"he".
                        alt = orig.replace("を", "お").replace("ヲ", "オ")
                        romaji = "".join(i.get("hepburn", "") or "" for i in kks.convert(alt))
                    # Hepburn's syllable apostrophe (kin'en) is not sung: no "'" CTC token for Japanese.
                    toks = _romanized_tokens(orig, romaji.replace("'", ""), unromanized)
                    if toks and orig.strip():
                        out.append(("".join(toks), orig.strip()))
            return out
    if language == "zh":
        try:
            from pypinyin import lazy_pinyin
        except ImportError:
            lazy_pinyin = None
        # One character (one syllable) per word, also for uroman's fallback readings; without any romanizer
        # the line takes the Latin path below like before.
        if lazy_pinyin is not None or _uroman() is not None:
            out = []

            def per_char(segment):
                for ch in segment:
                    if ch.strip():
                        reading = " ".join(lazy_pinyin(ch, v_to_u=True)) if lazy_pinyin is not None else ch
                        toks = _romanized_tokens(ch, reading, unromanized)
                        if toks:
                            out.append(("".join(toks), ch))

            if lazy_pinyin is None:
                per_char(text)
                return out
            # The reading of a run of Han characters is chosen with its phrase context (音乐 yin yue, not
            # yin le; 重新 chong xin); the output stays one word per character. v_to_u: ü (女 nü -> nu), not v.
            pos = 0
            for m in _HAN_RUN.finditer(text):
                per_char(text[pos:m.start()])
                run = m.group(0)
                readings = lazy_pinyin(run, v_to_u=True)
                if len(readings) == len(run):
                    for ch, reading in zip(run, readings):
                        toks = _romanized_tokens(ch, reading, unromanized)
                        if toks:
                            out.append(("".join(toks), ch))
                else:
                    per_char(run)
                pos = m.end()
            per_char(text[pos:])
            return out
    out = []
    for w in re.findall(r"\S+", text):
        toks = _romanized_tokens(w, w, unromanized)
        if toks:
            out.append(("".join(toks), w))
    return out


def _warn_unromanized(skipped_lines: list, dropped_words: int) -> None:
    """One console warning per run for the lines / words only uroman could have romanized (it is not installed)."""
    parts = []
    if skipped_lines:
        parts.append(f"{len(skipped_lines)} 行をスキップ（{', '.join(str(n) for n in skipped_lines)} 行目）")
    if dropped_words:
        parts.append(f"{dropped_words} 語の全部または一部を無視")
    logging.warning(
        "MCS_AlignLyrics: uroman が未導入のためローマ字化できない語があります（%s）。"
        "設定の「セットアップをやり直す」で「多言語ローマ字化（uroman）」を導入してください。",
        "、".join(parts),
    )


# Share of the emission frames the targets (tokens + adjacent repeats) may use. forced_align needs
# frames >= tokens + repeats; far below that (about 25 letters/s against 50 frames/s, sung lyrics rarely
# pass 15) the song ended before the lyrics did, e.g. a render cut off by the token budget.
_ALIGN_FRAME_BUDGET = 0.5
# wav2vec2's receptive field: shorter audio yields no frame at all.
_WAV2VEC2_RECEPTIVE_FIELD = 400
_OPTIONAL_ROMANIZERS = ("pykakasi", "pypinyin", "uroman")


def _ctc_need(ids: list, prev=None) -> int:
    """Frames forced_align needs for `ids` appended after token `prev`: one per token plus one per token equal
    to the one before it (the aligner flattens all words and lines with no blank between them)."""
    need = len(ids)
    for tok in ids:
        if tok == prev:
            need += 1
        prev = tok
    return need


def _lines_that_fit(line_ids: list, frames: int) -> int:
    """How many leading lines to align. line_ids: per line, its token ids in order. All of them when their
    targets fit into _ALIGN_FRAME_BUDGET of the frames; otherwise the longest prefix that does (lines are
    never cut in the middle), or just the first line when only it fits into the frames at all. 0: not even
    the first line fits."""
    budget = frames * _ALIGN_FRAME_BUDGET
    need = 0
    prev = None
    keep = 0
    for ids in line_ids:
        need += _ctc_need(ids, prev)
        if ids:
            prev = ids[-1]
        if need > budget:
            break
        keep += 1
    if keep == len(line_ids):
        return keep
    if keep == 0 and line_ids and _ctc_need(line_ids[0]) <= frames:
        return 1
    return keep


def _alignment_result(lines: list, line_items: list, token_spans: list, dropped_items: list, ratio: float, end_s: float) -> list:
    """The node's JSON entries: one per aligned line (start of its first word, end of its last one, words with
    their mean token score), in line order, then one per line that did not fit into the audio (index kept,
    start = end = the audio's end, every word score 0.0: the app treats them as not found and estimates them)."""
    per_line = {}
    for (li, _tok, orig), spans in zip(line_items, token_spans):
        start = spans[0].start * ratio
        end = spans[-1].end * ratio
        score = sum(s.score for s in spans) / max(1, len(spans))
        entry = per_line.setdefault(li, {"line": lines[li], "start": start, "end": end, "words": []})
        entry["end"] = max(entry["end"], end)
        entry["words"].append({"text": orig, "start": round(start, 3), "end": round(end, 3), "score": round(float(score), 3)})
    result = []
    for li, e in per_line.items():  # insertion order = line order
        e.update(start=round(e["start"], 3), end=round(e["end"], 3), index=li)
        result.append(e)
    end_r = round(end_s, 3)
    missing = {}
    for li, _tok, orig in dropped_items:
        entry = missing.setdefault(li, {"line": lines[li], "start": end_r, "end": end_r, "words": [], "index": li})
        entry["words"].append({"text": orig, "start": end_r, "end": end_r, "score": 0.0})
    result.extend(missing.values())
    return result


class MCS_AlignLyrics:
    """Align lyric lines to (preferably separated) vocals. Outputs JSON: [{line, start, end, words:[{text,start,end}]}]."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "lyrics": ("STRING", {"multiline": True, "default": ""}),
                "language": (["ja", "en", "zh", "other"], {"default": "ja"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("alignment_json",)
    FUNCTION = "align"
    OUTPUT_NODE = True
    CATEGORY = "MCS YuE2"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Which optional romanizers are importable changes the result, and the app's setup can pip-install
        # them while ComfyUI runs: part of the cache key, so the same song is aligned again after an install.
        # (**kwargs: ComfyUI passes only the constant inputs here.)
        import importlib
        import importlib.util

        importlib.invalidate_caches()  # a package installed into the live process after the last lookup
        return ",".join(m for m in _OPTIONAL_ROMANIZERS if importlib.util.find_spec(m) is not None)

    def align(self, audio, lyrics, language):
        import json

        import torchaudio
        from torchaudio.pipelines import MMS_FA as bundle

        wav = _single_item(audio, "MCS_AlignLyrics").detach().cpu().float()
        _require_finite(wav, "整列する音声")
        wav = wav.mean(0, keepdim=True)
        sr = int(audio["sample_rate"])
        lines = [l.strip() for l in lyrics.replace("\r\n", "\n").split("\n")]
        line_items = []  # (line_index, model_token, original)
        keep_lines = []
        skipped = []  # 1-based numbers of the lines only uroman could have romanized (it is not installed)
        dropped = 0  # words of such scripts dropped from lines that are still aligned
        for li, line in enumerate(lines):
            if not line or line.startswith("["):  # same rule as isNonLyricLine in the app (src/export/syncedLines.ts)
                continue
            unromanized = []
            toks = _romanize_line(line, language, unromanized)
            if not toks:
                if unromanized:
                    skipped.append(li + 1)
                continue
            dropped += len(unromanized)
            keep_lines.append((li, line))
            for tok, orig in toks:
                line_items.append((li, tok, orig))
        if skipped or dropped:
            _warn_unromanized(skipped, dropped)
        if not line_items:
            return {"ui": {"text": ["[]"]}, "result": ("[]",)}

        if sr != bundle.sample_rate:
            wav = torchaudio.functional.resample(wav, sr, bundle.sample_rate)
        if wav.shape[1] < _WAV2VEC2_RECEPTIVE_FIELD:
            raise ValueError("整列する音声が短すぎます（0.03 秒未満）。ボーカル分離の結果と音源を確認してください。")

        # MMS_FA is not managed by ComfyUI (/free cannot unload it): keep it on the CPU between runs and
        # move it to ComfyUI's device only while computing the emission.
        device = comfy.model_management.get_torch_device()
        model = _aligner_cache.get("model")
        if model is None:
            # The app keeps the weights in MCS_TORCH_HOME (setup downloads them to <it>/hub/checkpoints); passed
            # to torch.hub directly, so the process-wide TORCH_HOME of other nodes is not changed.
            cache_dir = os.environ.get("MCS_TORCH_HOME")
            dl_kwargs = {"model_dir": os.path.join(cache_dir, "hub", "checkpoints")} if cache_dir else None
            model = bundle.get_model(with_star=False, dl_kwargs=dl_kwargs).eval()
            _aligner_cache["model"] = model
            _aligner_cache["tokenizer"] = bundle.get_tokenizer()
            _aligner_cache["aligner"] = bundle.get_aligner()
        tokenizer = _aligner_cache["tokenizer"]
        aligner = _aligner_cache["aligner"]
        item_ids = tokenizer([t for _, t, _ in line_items])
        ids_by_line = {}
        for (li, _, _), ids in zip(line_items, item_ids):
            ids_by_line.setdefault(li, []).extend(ids)
        line_ids = [ids_by_line[li] for li, _ in keep_lines]  # per kept line, its token ids in order

        hop = _feature_hop(model)
        ratio = hop / bundle.sample_rate  # seconds per emission frame
        comfy.model_management.throw_exception_if_processing_interrupted()  # before moving the model to the GPU
        emission = None
        try:
            model.to(device)
            with torch.inference_mode():
                emission = _chunked_emission(model, wav, device, hop, bundle.sample_rate)
                frames = int(emission.shape[1])
                fit = _lines_that_fit(line_ids, frames)
                if fit == 0:
                    raise ValueError(
                        f"音声が短すぎて歌詞を整列できません（音声 {frames * ratio:.1f} 秒に対して歌詞が長すぎます）。"
                        "曲が途中で終わっていないか、歌詞と音源が同じ曲か確認してください。"
                    )
                fit_lines = {li for li, _ in keep_lines[:fit]}
                n_fit = sum(1 for li, _, _ in line_items if li in fit_lines)  # line_items are in line order
                token_spans = aligner(emission[0], item_ids[:n_fit])
        finally:
            # (On errors the traceback still holds the partial emission; see MCS_VocalSeparate.)
            del emission
            model.to("cpu")
            comfy.model_management.soft_empty_cache()
        if fit < len(keep_lines):
            logging.warning(
                "MCS_AlignLyrics: 音声に対して歌詞が長すぎるため、先頭の %d 行だけを整列しました（残り %d 行は音声中に見つからなかった扱い）。",
                fit, len(keep_lines) - fit,
            )
        result = _alignment_result(lines, line_items[:n_fit], token_spans, line_items[n_fit:], ratio, frames * ratio)
        text = json.dumps(result, ensure_ascii=False)
        return {"ui": {"text": [text]}, "result": (text,)}


NODE_CLASS_MAPPINGS["MCS_AlignLyrics"] = MCS_AlignLyrics
NODE_DISPLAY_NAME_MAPPINGS["MCS_AlignLyrics"] = "MCS · Align Lyrics (MMS forced alignment)"


# ---------------------------------------------------------------------------------------------
# YuE2 generation status (semantic frames / token-budget truncation) for the app
# ---------------------------------------------------------------------------------------------

_YUE2_FRAMES_PER_SECOND = 25  # comfy/text_encoders/yue2.py FRAMES_PER_SECOND


class MCS_YuE2Status:
    """Report what YuE2 Generate Music stored in its CONDITIONING: generated frames and whether the
    semantic stage hit its token budget before the end token (yue2_truncated). JSON text for the app."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"conditioning": ("CONDITIONING",)}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("status_json",)
    FUNCTION = "status"
    OUTPUT_NODE = True
    CATEGORY = "MCS YuE2"

    def status(self, conditioning):
        import json

        meta = conditioning[0][1] if conditioning and len(conditioning[0]) > 1 else {}
        frames = int(meta.get("yue2_frames", 0) or 0)
        payload = {
            "frames": frames,
            "seconds": round(frames / _YUE2_FRAMES_PER_SECOND, 3),
            "truncated": bool(meta.get("yue2_truncated", False)),
            "valid": "yue2_frames" in meta,  # False: not connected to YuE2 Generate Music
        }
        text = json.dumps(payload)
        return {"ui": {"text": [text]}, "result": (text,)}


NODE_CLASS_MAPPINGS["MCS_YuE2Status"] = MCS_YuE2Status
NODE_DISPLAY_NAME_MAPPINGS["MCS_YuE2Status"] = "MCS · YuE2 Status (frames / truncation)"
