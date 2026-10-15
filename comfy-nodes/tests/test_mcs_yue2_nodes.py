"""Standalone tests for comfy-nodes/mcs_yue2_nodes (run with ComfyUI's embedded Python).

    <python_embeded>/python.exe comfy-nodes/tests/test_mcs_yue2_nodes.py [--comfy <ComfyUI dir>] [--no-model]

The node pack imports folder_paths / comfy.model_management, so the ComfyUI directory must be importable
(default: the MCS_COMFY_DIR env var, else the ComfyUI next to the Python that runs the tests, else
C:/MCSYuE2/runtime/ComfyUI_windows_portable/ComfyUI).
audio-separator is replaced by a fake that mimics 0.47.0's output_dir / file naming behaviour; the installed package's
Separator signature is checked against the arguments the node passes (in a separate process).
Tests that need the real MMS_FA weights run only when they are already cached (MCS_TORCH_HOME, <MCS_DATA_ROOT>/models/torch
or C:/MCSYuE2/models/torch); --no-model skips them. Skipped tests are listed as SKIP and counted separately.
The pack's work / model folders are redirected to a temporary folder (MCS_TEMP_DIR,
MCS_SEPARATION_MODELS_DIR), so nothing is written into the ComfyUI installation.
"""

import argparse
import contextlib
import json
import logging
import os
import shutil
import sys
import tempfile
import traceback
import types
import unicodedata
import warnings

sys.dont_write_bytecode = True  # keep __pycache__ out of the bundled node pack

HERE = os.path.dirname(os.path.abspath(__file__))
PACK_PARENT = os.path.dirname(HERE)  # comfy-nodes/



def _default_comfy_dir():
    """MCS_COMFY_DIR, else the ComfyUI next to the Python running the tests (the portable layout: python_embeded
    and ComfyUI side by side), else the default data root's."""
    if os.environ.get("MCS_COMFY_DIR"):
        return os.environ["MCS_COMFY_DIR"]
    beside = os.path.normpath(os.path.join(os.path.dirname(sys.executable), "..", "ComfyUI"))
    return beside if os.path.isdir(beside) else "C:/MCSYuE2/runtime/ComfyUI_windows_portable/ComfyUI"


ap = argparse.ArgumentParser()
ap.add_argument("--comfy", default=_default_comfy_dir())
ap.add_argument("--no-model", action="store_true", help="skip tests that load the real MMS_FA weights")
ARGS = ap.parse_args()
sys.argv = sys.argv[:1]  # comfy.cli_args must not see our flags

sys.path.insert(0, ARGS.comfy)
sys.path.insert(0, PACK_PARENT)

# Before the pack is imported (it sweeps its work root on import); created with the unpatched mkdtemp below.
TEST_ROOT = tempfile.mkdtemp(prefix="mcs_nodes_test_")
os.environ["MCS_TEMP_DIR"] = os.path.join(TEST_ROOT, "temp")
os.environ["MCS_SEPARATION_MODELS_DIR"] = os.path.join(TEST_ROOT, "separation_models")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402

import folder_paths  # noqa: E402

INSTALL_SEP_DIR = os.path.join(folder_paths.models_dir, "audio_separator")
INSTALL_SEP_DIR_EXISTED = os.path.exists(INSTALL_SEP_DIR)


def _tree(d):
    """Sorted relative paths under d (a snapshot to compare when the folder already existed)."""
    out = []
    for root, dirs, files in os.walk(d):
        out += [os.path.relpath(os.path.join(root, n), d) for n in dirs + files]
    return sorted(out)


INSTALL_SEP_TREE = _tree(INSTALL_SEP_DIR) if INSTALL_SEP_DIR_EXISTED else None


def _real_separator_params():
    """Parameter names of the installed audio-separator's Separator.__init__ ({"names": [...], "varkw": bool}) and
    the internals the node relies on ("download", "download_calls", "mdxc_tqdm_loop", "demucs_tqdm": a value, or the
    repr of the error that probe raised), read in a separate process with the same Python (the real package is heavy
    and must not replace the fake below); None when the package is not installed, an Exception when it cannot be
    inspected."""
    import importlib.util
    import json
    import subprocess

    if importlib.util.find_spec("audio_separator") is None:
        return None
    code = (
        "import inspect, json, os, re\n"
        "from audio_separator.separator import Separator\n"
        "p = inspect.signature(Separator.__init__).parameters\n"
        "def sep_dir():  # audio_separator/separator\n"
        "    return os.path.dirname(os.path.abspath(inspect.getfile(Separator)))\n"
        "def read(path):\n"
        "    with open(path, encoding='utf-8') as f:\n"
        "        return f.read()\n"
        "def probe(f):\n"
        "    try:\n"
        "        return f()\n"
        "    except Exception as e:\n"
        "        return repr(e)\n"
        "def demucs_tqdm():\n"
        "    files = [os.path.join(d, 'apply.py') for d, _, names in os.walk(sep_dir()) if os.path.basename(d) == 'demucs' and 'apply.py' in names]\n"
        "    return bool(files) and all('tqdm.tqdm(' in read(f) for f in files)\n"
        "print(json.dumps({'names': list(p), 'varkw': any(v.kind == v.VAR_KEYWORD for v in p.values()),\n"
        "    'download': probe(lambda: list(inspect.signature(Separator.download_file_if_not_exists).parameters)),\n"
        "    'download_calls': probe(lambda: read(inspect.getfile(Separator)).count('self.download_file_if_not_exists(')),\n"
        "    'mdxc_tqdm_loop': probe(lambda: bool(re.search(r'for .+ in tqdm\\(', read(os.path.join(sep_dir(), 'architectures', 'mdxc_separator.py'))))),\n"
        "    'demucs_tqdm': probe(demucs_tqdm)}))\n"
    )
    try:
        r = subprocess.run([sys.executable, "-B", "-c", code], capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            return RuntimeError(r.stderr.strip()[-2000:])
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception as e:  # noqa: BLE001
        return e


REAL_SEP_PARAMS = _real_separator_params()

import mcs_yue2_nodes  # noqa: E402
from mcs_yue2_nodes import nodes  # noqa: E402


class Skip(Exception):
    """Raised by a test that cannot run here (optional package or model missing); reported as SKIP."""

# ---------------------------------------------------------------------------------------------
# Fake audio_separator (0.47.0 behaviour: load_model copies output_dir into the model instance, the
# architecture writes to model_instance.output_dir and returns bare file names)
# ---------------------------------------------------------------------------------------------

STEMS = {
    "model_bs_roformer_ep_317_sdr_12.9755.ckpt": [("Instrumental", 0.6), ("Vocals", 0.4)],
    "vocals_mel_band_roformer.ckpt": [("other", 0.7), ("vocals", 0.3)],
    "htdemucs_ft.yaml": [("Bass", 0.1), ("Drums", 0.2), ("Other", 0.3), ("Vocals", 0.4)],
}
# downloads: [([url, fallback url], file name)] fetched by load_model like the library (second repository on a
# RuntimeError); on_load / on_separate: called inside load_model / separate; input: the last input.wav, (frames, ch)
FAKE = {"instances": 0, "fail": False, "kwargs": None, "dirs": [], "model_dirs": [], "downloads": [], "on_load": None, "on_separate": None, "input": None}


class _FakeModelInstance:
    def __init__(self, output_dir, model_filename):
        self.output_dir = output_dir
        self.model_name = model_filename.split(".")[0]
        # (stem, gain): a factor of the input, or a function of the input data (frames, ch)
        self.stems = STEMS.get(model_filename, [("Instrumental", 0.6), ("Vocals", 0.4)])


class FakeSeparator:
    def __init__(self, log_level=30, model_file_dir=None, output_dir=None, output_format="WAV", **kwargs):
        FAKE["instances"] += 1
        FAKE["kwargs"] = kwargs
        FAKE["dirs"].append(output_dir)
        FAKE["model_dirs"].append(model_file_dir)
        self.model_file_dir = model_file_dir
        self.output_dir = output_dir
        self.normalization_threshold = kwargs.get("normalization_threshold", 0.9)
        self.model_instance = None
        # audio-separator 0.47.0 does this in __init__ whenever log_level > DEBUG (process-wide)
        warnings.filterwarnings("ignore")

    def download_file_if_not_exists(self, url, output_path):
        # audio-separator 0.47.0 (separator.py): skips an existing file, streams straight into the final path
        if os.path.isfile(output_path):
            return
        import requests

        response = requests.get(url, stream=True, timeout=300)
        if response.status_code == 200:
            with open(output_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
        else:
            raise RuntimeError(f"Failed to download file from {url}, response code: {response.status_code}")

    def load_model(self, model_filename):
        for urls, name in FAKE["downloads"]:  # download_model_files: the second repository after a RuntimeError
            path = os.path.join(self.model_file_dir, name)
            try:
                self.download_file_if_not_exists(urls[0], path)
            except RuntimeError:
                self.download_file_if_not_exists(urls[1], path)
        if FAKE["on_load"]:
            FAKE["on_load"]()
        self.model_instance = _FakeModelInstance(self.output_dir, model_filename)

    def separate(self, path):
        if FAKE["fail"]:
            raise RuntimeError("fake separation failure")
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        FAKE["input"] = data
        if FAKE["on_separate"]:
            FAKE["on_separate"]()
        mi = self.model_instance
        os.makedirs(mi.output_dir, exist_ok=True)
        base = os.path.splitext(os.path.basename(path))[0]
        names = []
        for stem, gain in mi.stems:
            name = f"{base}_({stem})_{mi.model_name}.wav"
            out = gain(data) if callable(gain) else data * gain
            # the library's writer scales every stem on its own (spec_utils.normalize, normalization_threshold)
            peak = float(np.abs(out).max()) if out.size else 0.0
            if peak > self.normalization_threshold:
                out = out * (self.normalization_threshold / peak)
            sf.write(os.path.join(mi.output_dir, name), out, sr, subtype="FLOAT")
            names.append(name)
        return names


fake_pkg = types.ModuleType("audio_separator")
fake_mod = types.ModuleType("audio_separator.separator")
fake_mod.Separator = FakeSeparator
fake_pkg.separator = fake_mod
sys.modules["audio_separator"] = fake_pkg
sys.modules["audio_separator.separator"] = fake_mod

CREATED_DIRS = []
_real_mkdtemp = tempfile.mkdtemp


def _recording_mkdtemp(*a, **kw):
    d = _real_mkdtemp(*a, **kw)
    CREATED_DIRS.append(d)
    return d


tempfile.mkdtemp = _recording_mkdtemp


def _audio(x, sr=44100):
    return {"waveform": x, "sample_rate": sr}


def _sine(seconds=1.0, sr=44100, ch=2, amp=0.5):
    t = torch.arange(int(seconds * sr)) / sr
    w = amp * torch.sin(2 * torch.pi * 440 * t)
    return w.repeat(ch, 1).unsqueeze(0)  # (1, ch, frames)


# ---------------------------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------------------------


def test_stem_label_and_classification():
    p = [
        "input_(other)_vocals_mel_band_roformer.wav",
        "input_(vocals)_vocals_mel_band_roformer.wav",
    ]
    assert nodes._stem_label(p[0]) == "other"
    v, o = nodes._classify_stems(p)
    assert v == p[1] and o == [p[0]], (v, o)
    demucs = [f"input_({s})_htdemucs_ft.wav" for s in ("Bass", "Drums", "Other", "Vocals")]
    v, o = nodes._classify_stems(demucs)
    assert v.endswith("(Vocals)_htdemucs_ft.wav") and len(o) == 3
    v, o = nodes._classify_stems(["input_(No Vocals)_x.wav", "input_(Vocals)_x.wav"])
    assert o == ["input_(No Vocals)_x.wav"]
    try:
        nodes._classify_stems(["input_(Bass)_x.wav", "input_(Drums)_x.wav"])
        raise AssertionError("expected RuntimeError without a vocals stem")
    except RuntimeError as e:
        assert "bass" in str(e) and "drums" in str(e), e


def _run_separate(model, x):
    before = len(CREATED_DIRS)
    n = FAKE["instances"]
    v, i = nodes.MCS_VocalSeparate().separate(_audio(x), model)
    work = CREATED_DIRS[before:]
    assert len(work) == 1 and not os.path.exists(work[0]), f"work dir left behind: {work}"
    assert os.path.dirname(work[0]) == os.environ["MCS_TEMP_DIR"] and os.path.basename(work[0]).startswith("mcs_sep_"), work
    # a new separator per run, writing into that run's work dir
    assert FAKE["instances"] == n + 1 and FAKE["dirs"][-1] == work[0], (FAKE["dirs"][-1], work)
    return v, i


def test_separate_models_twice_and_cleanup():
    x = _sine(0.5)
    for model, stems in STEMS.items():
        inst_gain = sum(g for s, g in stems if s.lower() != "vocals")
        voc_gain = sum(g for s, g in stems if s.lower() == "vocals")
        for _ in range(2):  # second run in one session used to fail (stale model_instance.output_dir)
            v, i = _run_separate(model, x)
            assert v["waveform"].shape == x.shape and i["waveform"].shape == x.shape
            assert torch.allclose(v["waveform"], x * voc_gain, atol=1e-6), model
            assert torch.allclose(i["waveform"], x * inst_gain, atol=1e-6), model
            assert v["sample_rate"] == 44100 and i["sample_rate"] == 44100
    # the models go to the test's own folder, never into the ComfyUI installation (checked directly, also on a
    # machine where the installation's models/audio_separator already exists)
    root = os.path.normcase(os.path.abspath(TEST_ROOT))
    assert FAKE["model_dirs"] and all(os.path.normcase(os.path.abspath(d)).startswith(root) for d in FAKE["model_dirs"]), FAKE["model_dirs"]


def test_real_separator_accepts_our_arguments():
    # The fake takes any keyword: a renamed or removed Separator argument would pass every other test and then
    # fail every real separation with a TypeError (e.g. after the audio-separator pin in setup.rs changes).
    if REAL_SEP_PARAMS is None:
        raise Skip("audio-separator not installed")
    if isinstance(REAL_SEP_PARAMS, Exception):
        raise AssertionError(f"cannot inspect the installed audio-separator: {REAL_SEP_PARAMS}")
    assert not REAL_SEP_PARAMS["varkw"], "Separator.__init__ takes **kwargs: the check would prove nothing"
    names = set(REAL_SEP_PARAMS["names"])
    for fn in nodes.SEPARATION_MODELS:
        used = {"log_level", "model_file_dir", "output_dir", "output_format"} | set(nodes._separator_kwargs(fn))
        assert used <= names, (fn, sorted(used - names))


def test_real_separator_internals_the_node_hooks():
    # _new_separator replaces self.download_file_if_not_exists (every model, config and download_checks.json download
    # goes through it), and _tqdm_checks_interrupt relies on the Roformer / Demucs chunk loops iterating tqdm bars. A
    # changed audio-separator would silently bring back truncated models and a キャンセル that only takes effect at the end.
    if REAL_SEP_PARAMS is None:
        raise Skip("audio-separator not installed")
    if isinstance(REAL_SEP_PARAMS, Exception):
        raise AssertionError(f"cannot inspect the installed audio-separator: {REAL_SEP_PARAMS}")
    p = REAL_SEP_PARAMS
    assert p["download"] == ["self", "url", "output_path"], p["download"]
    assert isinstance(p["download_calls"], int) and p["download_calls"] >= 2, p["download_calls"]
    assert p["mdxc_tqdm_loop"] is True and p["demucs_tqdm"] is True, (p["mdxc_tqdm_loop"], p["demucs_tqdm"])


def test_separate_multi_stem_threshold_and_peak_limit():
    orig = STEMS["htdemucs_ft.yaml"]
    STEMS["htdemucs_ft.yaml"] = [("Bass", 0.5), ("Drums", 0.5), ("Other", 0.5), ("Vocals", 0.95)]
    try:
        x = _sine(0.3, amp=1.0)
        v, i = _run_separate("htdemucs_ft.yaml", x)
        assert FAKE["kwargs"] == {"normalization_threshold": 1.0, "use_soundfile": True}, FAKE["kwargs"]
        # summed stems (peak 1.5) and the vocals (0.95) are scaled to the library's 0.9, balance kept
        assert torch.allclose(i["waveform"], x * 0.9, atol=1e-5), float(i["waveform"].abs().max())
        assert torch.allclose(v["waveform"], x * 0.9, atol=1e-5)
    finally:
        STEMS["htdemucs_ft.yaml"] = orig
    _run_separate("model_bs_roformer_ep_317_sdr_12.9755.ckpt", _sine(0.2))
    assert FAKE["kwargs"] == {"use_soundfile": True}, "2-stem models keep audio-separator's default normalization; float stems"


def test_limit_peak():
    w = torch.tensor([[[0.5, -1.8, 0.9]]])
    assert torch.allclose(nodes._limit_peak(w), w * (0.9 / 1.8))
    q = torch.tensor([[[0.5, -0.9]]])
    assert nodes._limit_peak(q) is q


def test_apply_comfy_device():
    mm = nodes.comfy.model_management
    orig = mm.get_torch_device
    orig_current = torch.cuda.current_device
    try:
        torch.cuda.current_device = lambda: 0  # runs without CUDA too
        sep = types.SimpleNamespace(torch_device=torch.device("cuda"), onnx_execution_provider=["CUDAExecutionProvider"])
        mm.get_torch_device = lambda: torch.device("cuda", 0)
        nodes._apply_comfy_device(sep)
        assert sep.torch_device == torch.device("cuda") and sep.torch_device.index is None, "the current device keeps the library's cache clearing"
        sep = types.SimpleNamespace(torch_device=torch.device("cuda"), onnx_execution_provider=["CUDAExecutionProvider"])
        mm.get_torch_device = lambda: torch.device("cpu")
        nodes._apply_comfy_device(sep)
        assert sep.torch_device.type == "cpu" and sep.onnx_execution_provider == ["CPUExecutionProvider"]
        sep = types.SimpleNamespace(torch_device=torch.device("cuda"), onnx_execution_provider=["CUDAExecutionProvider"])
        mm.get_torch_device = lambda: torch.device("cuda", 1)
        nodes._apply_comfy_device(sep)
        assert sep.torch_device == torch.device("cuda", 1)
        sep = types.SimpleNamespace(torch_device=torch.device("mps"))
        nodes._apply_comfy_device(sep)
        assert sep.torch_device.type == "mps", "a non-CUDA accelerator chosen by the library stays"
    finally:
        mm.get_torch_device = orig
        torch.cuda.current_device = orig_current


def test_mix_stems_rejects_mismatch():
    d = _real_mkdtemp()
    try:
        a, b, c = (os.path.join(d, n) for n in ("a.wav", "b.wav", "c.wav"))
        sf.write(a, np.zeros((100, 2), np.float32), 44100, subtype="FLOAT")
        sf.write(b, np.zeros((100, 2), np.float32), 48000, subtype="FLOAT")
        sf.write(c, np.zeros((100, 1), np.float32), 44100, subtype="FLOAT")
        for other in (b, c):
            try:
                nodes._mix_stems([a, other])
                raise AssertionError("expected RuntimeError")
            except RuntimeError as e:
                assert "一致しません" in str(e), e
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_missing_audio_separator():
    saved = {k: sys.modules[k] for k in ("audio_separator", "audio_separator.separator")}
    sys.modules["audio_separator"] = None
    sys.modules["audio_separator.separator"] = None
    try:
        nodes._new_separator("htdemucs_ft.yaml", "unused")  # raises before touching output_dir
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "audio-separator" in str(e) and isinstance(e.__cause__, ImportError), e
    finally:
        sys.modules.update(saved)


def test_feature_hop_fallback():
    assert nodes._feature_hop(object()) == nodes._WAV2VEC2_HOP == 320


def test_align_rejects_nonfinite():
    try:
        nodes.MCS_AlignLyrics().align(_audio(torch.tensor([[[0.0, float("nan")]]])), "hello", "en")
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


def test_separator_warning_filter_is_scoped():
    # The Separator's process-wide "ignore" filter must not outlive the node run.
    before = list(warnings.filters)
    _run_separate("model_bs_roformer_ep_317_sdr_12.9755.ckpt", _sine(0.2))
    assert warnings.filters == before, "warnings filters changed by the separation"
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("default")
        warnings.warn("still reported", UserWarning)
    assert len(caught) == 1


def test_stale_work_dirs_are_swept():
    root = os.environ["MCS_TEMP_DIR"]
    old = os.path.join(root, "mcs_sep_oldrun")
    fresh = os.path.join(root, "mcs_sep_freshrun")
    other = os.path.join(root, "not_ours_old")
    for d in (old, fresh, other):
        os.makedirs(os.path.join(d, "sub"), exist_ok=True)
        with open(os.path.join(d, "input.wav"), "wb") as f:
            f.write(b"x")
    past = os.path.getmtime(old) - 13 * 3600
    for d in (old, other):
        os.utime(d, (past, past))
    try:
        assert nodes._sweep_stale_work_dirs(root) == 1
        assert not os.path.exists(old) and os.path.exists(fresh) and os.path.exists(other)
        assert nodes._sweep_stale_work_dirs(os.path.join(root, "missing")) == 0  # never raises
    finally:
        for d in (old, fresh, other):
            shutil.rmtree(d, ignore_errors=True)


def test_separate_failure_cleans_up():
    FAKE["fail"] = True
    before = len(CREATED_DIRS)
    try:
        nodes.MCS_VocalSeparate().separate(_audio(_sine(0.2)), "htdemucs_ft.yaml")
        raise AssertionError("expected failure")
    except RuntimeError as e:
        assert "fake separation failure" in str(e)
    finally:
        FAKE["fail"] = False
    work = CREATED_DIRS[before:]
    assert len(work) == 1 and not os.path.exists(work[0]), "work dir must be removed on errors"


def test_separate_guards():
    for bad, what in ((torch.zeros(2, 2, 100), "batch"), (torch.tensor([[[0.0, float("nan")]]]), "nan")):
        before = len(CREATED_DIRS)
        try:
            nodes.MCS_VocalSeparate().separate(_audio(bad), "htdemucs_ft.yaml")
            raise AssertionError(f"expected ValueError for {what}")
        except ValueError:
            pass
        assert len(CREATED_DIRS) == before, "guards must run before creating the temp dir"


def _separate_error(model, x):
    """The exception MCS_VocalSeparate.separate raises, ComfyUI's InterruptProcessingException included (a
    BaseException in current ComfyUI); AssertionError when it returns, or when SystemExit escapes."""
    try:
        nodes.MCS_VocalSeparate().separate(_audio(x), model)
    except SystemExit as e:
        raise AssertionError(f"SystemExit({e.code}) escaped the node: it would end ComfyUI's prompt worker thread") from None
    except nodes.comfy.model_management.InterruptProcessingException as e:
        return e
    except Exception as e:  # noqa: BLE001
        return e
    raise AssertionError("expected an error")


class _FakeResponse:
    """A streamed requests response: its chunks, then `error` raised mid-stream; `between` runs after the first chunk."""

    def __init__(self, chunks=(), status=200, headers=None, error=None, between=None):
        self.chunks = list(chunks)
        self.status_code = status
        self.headers = headers or {}  # lower-case keys (requests' headers are case-insensitive)
        self.error = error
        self.between = between
        self.closed = False

    def iter_content(self, chunk_size=1):
        for k, c in enumerate(self.chunks):
            if k == 1 and self.between:
                self.between()
            yield c
        if self.error is not None:
            raise self.error

    def close(self):
        self.closed = True


class _FakeRequestException(OSError):
    """requests.RequestException: an IOError like requests' own (ChunkedEncodingError, ConnectionError …)."""


@contextlib.contextmanager
def _fake_requests(routes):
    """`import requests` gives a module whose get(url) returns routes[url] (raises it when it is an exception, as
    requests itself does before any response); yields the list of requested URLs."""
    calls = []
    mod = types.ModuleType("requests")

    def get(url, stream=False, timeout=None):
        calls.append(url)
        if isinstance(routes[url], BaseException):
            raise routes[url]
        return routes[url]

    mod.get = get
    mod.RequestException = _FakeRequestException
    saved = sys.modules.get("requests")
    sys.modules["requests"] = mod
    try:
        yield calls
    finally:
        if saved is None:
            sys.modules.pop("requests", None)
        else:
            sys.modules["requests"] = saved


def test_download_atomic_keeps_no_partial_file():
    d = _real_mkdtemp()
    try:
        p = os.path.join(d, "download_checks.json")
        part = p + nodes._PART_SUFFIX
        # cut off mid-stream (the library's own download kept these 27 bytes, and skipped the file ever after)
        cut = _FakeResponse([b'{"vr_download_list": {"a": '], headers={"content-length": "28267"}, error=ConnectionError("Connection broken: IncompleteRead"))
        failures = []
        with _fake_requests({"u": cut}):
            try:
                nodes._download_atomic("u", p, failures)
                raise AssertionError("expected the connection error")
            except ConnectionError:
                pass
        assert not os.path.exists(p) and not os.path.exists(part), os.listdir(d)
        assert len(failures) == 1 and failures[0][1] == p and cut.closed, failures
        assert failures[0][2] is False, "the stream failed, not a file operation"
        # a body shorter than its Content-Length without an error (connection closed early) is not kept either
        failures = []
        with _fake_requests({"u": _FakeResponse([b"x" * 50], headers={"content-length": "100"})}):
            try:
                nodes._download_atomic("u", p, failures)
                raise AssertionError("expected OSError")
            except OSError as e:
                assert "50 of 100" in str(e), e
        assert not os.path.exists(p) and not os.path.exists(part) and len(failures) == 1
        # not found: the library's RuntimeError (download_model_files then tries its second repository)
        with _fake_requests({"u": _FakeResponse(status=404)}):
            try:
                nodes._download_atomic("u", p, [])
                raise AssertionError("expected RuntimeError")
            except RuntimeError as e:
                assert "404" in str(e), e
        assert not os.path.exists(p) and not os.path.exists(part)
        # complete: renamed into place; a gzip body is not compared with Content-Length (requests decodes it)
        q = os.path.join(d, "config.yaml")
        routes = {"u": _FakeResponse([b"{}", b"\n"], headers={"content-length": "3"}), "g": _FakeResponse([b"dim: 384\n"], headers={"content-length": "5", "content-encoding": "gzip"})}
        with _fake_requests(routes) as calls:
            nodes._download_atomic("u", p, [])
            nodes._download_atomic("g", q, [])
            nodes._download_atomic("u", p, [])  # exists: no request
        assert calls == ["u", "g"], calls
        with open(p, "rb") as f:
            assert f.read() == b"{}\n"
        with open(q, "rb") as f:
            assert f.read() == b"dim: 384\n"
        assert sorted(os.listdir(d)) == ["config.yaml", "download_checks.json"], os.listdir(d)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_download_atomic_stops_on_interrupt():
    mm = nodes.comfy.model_management
    d = _real_mkdtemp()
    try:
        p = os.path.join(d, "vocals_mel_band_roformer.ckpt")
        resp = _FakeResponse([b"PK", b"more", b"rest"], between=lambda: mm.interrupt_current_processing(True))  # キャンセル
        failures = []
        with _fake_requests({"u": resp}):
            try:
                nodes._download_atomic("u", p, failures)
                raise AssertionError("expected InterruptProcessingException")
            except mm.InterruptProcessingException:
                pass
        assert os.listdir(d) == [] and failures == [], (os.listdir(d), failures)
    finally:
        mm.interrupt_current_processing(False)
        shutil.rmtree(d, ignore_errors=True)


def test_separate_download_failure_leaves_nothing_behind():
    model_dir = os.environ["MCS_SEPARATION_MODELS_DIR"]
    name = "vocals_mel_band_roformer.ckpt"  # fetched by audio-separator on first use
    target = os.path.join(model_dir, name)
    urls = ["https://uvr.invalid/" + name, "https://as.invalid/" + name]
    FAKE["downloads"] = [(urls, name)]
    try:
        cut = _FakeResponse([b"PK\x03\x04" + bytes(100)], headers={"content-length": "913097458"}, error=ConnectionError("Connection broken: IncompleteRead"))
        before = len(CREATED_DIRS)
        with _fake_requests({urls[0]: cut}):
            e = _separate_error(name, _sine(0.2))
        assert isinstance(e, RuntimeError) and "取得できませんでした" in str(e) and name in str(e), e
        assert isinstance(e.__cause__, ConnectionError), repr(e.__cause__)
        left = [f for f in os.listdir(model_dir) if f.startswith(name)]
        assert left == [], f"a truncated model would be skipped by every later download: {left}"
        work = CREATED_DIRS[before:]
        assert len(work) == 1 and not os.path.exists(work[0]), "work dir must be removed on errors"
        # nothing truncated was kept, so the next run downloads the file again
        with _fake_requests({urls[0]: _FakeResponse([b"PK", b"data"], headers={"content-length": "6"})}) as calls:
            _run_separate(name, _sine(0.2))
        assert calls == [urls[0]], calls
        with open(target, "rb") as f:
            assert f.read() == b"PKdata"
        # not found in the first repository: the library's fallback to its second one still works
        os.remove(target)
        with _fake_requests({urls[0]: _FakeResponse(status=404), urls[1]: _FakeResponse([b"ok"])}) as calls:
            _run_separate(name, _sine(0.2))
        assert calls == urls, calls
        with open(target, "rb") as f:
            assert f.read() == b"ok"
    finally:
        FAKE["downloads"] = []
        if os.path.exists(target):
            os.remove(target)


def test_separate_download_failure_names_the_cause():
    # The app shows only the node's message: it keeps the real cause, and only network errors get the
    # internet advice (a full disk or a 404 is not fixed by checking the connection and downloading again).
    model_dir = os.environ["MCS_SEPARATION_MODELS_DIR"]
    name = "vocals_mel_band_roformer.ckpt"
    target = os.path.join(model_dir, name)
    blocker = target + nodes._PART_SUFFIX
    urls = ["https://uvr.invalid/" + name, "https://as.invalid/" + name]
    FAKE["downloads"] = [(urls, name)]
    try:
        # a requests error (an OSError, like requests' own): the connection, with its text
        cut = _FakeResponse([b"PK"], headers={"content-length": "913097458"}, error=_FakeRequestException("Connection broken: IncompleteRead"))
        with _fake_requests({urls[0]: cut}):
            e = _separate_error(name, _sine(0.2))
        assert isinstance(e, RuntimeError) and "インターネット接続" in str(e) and "IncompleteRead" in str(e), e
        # a body shorter than its Content-Length: the connection too
        with _fake_requests({urls[0]: _FakeResponse([b"PK"], headers={"content-length": "100"})}):
            e = _separate_error(name, _sine(0.2))
        assert "インターネット接続" in str(e) and "2 of 100" in str(e), e
        # an OSError requests raises itself before any response (REQUESTS_CA_BUNDLE inherited from the user's
        # environment, naming a file that is gone): no RequestException, but nothing was written - not the disk
        ca = OSError("Could not find a suitable TLS CA certificate bundle, invalid path: C:/gone/ca.pem")
        with _fake_requests({urls[0]: ca}):
            e = _separate_error(name, _sine(0.2))
        assert isinstance(e, RuntimeError) and e.__cause__ is ca, repr(e)
        assert "空き容量" not in str(e) and "インターネット接続" in str(e) and "TLS CA certificate bundle" in str(e), e
        assert not [f for f in os.listdir(model_dir) if f.startswith(name)], os.listdir(model_dir)
        # not found in both repositories: the response code and the URL; a retry cannot help
        with _fake_requests({urls[0]: _FakeResponse(status=404), urls[1]: _FakeResponse(status=404)}):
            e = _separate_error(name, _sine(0.2))
        assert isinstance(e, RuntimeError) and "404" in str(e) and urls[1] in str(e) and "インターネット接続" not in str(e), e
        # the file cannot be written (disk full, read-only folder, a file locked by antivirus): here open() of
        # <file>.mcs_part fails because a folder has that name. The folder and the OS error, no internet advice.
        os.makedirs(blocker)
        with _fake_requests({urls[0]: _FakeResponse([b"PK"])}):
            e = _separate_error(name, _sine(0.2))
        assert isinstance(e, RuntimeError) and isinstance(e.__cause__, OSError), repr(e)
        assert "インターネット接続" not in str(e) and "空き容量" in str(e) and model_dir in str(e) and "[Errno" in str(e), e
        assert not os.path.exists(target), os.listdir(model_dir)
        os.rmdir(blocker)
        # the complete file cannot be renamed into place (here a folder has the model's name): the folder too
        os.makedirs(target)
        with _fake_requests({urls[0]: _FakeResponse([b"PK"])}):
            e = _separate_error(name, _sine(0.2))
        assert isinstance(e, RuntimeError) and isinstance(e.__cause__, OSError), repr(e)
        assert "インターネット接続" not in str(e) and "空き容量" in str(e) and model_dir in str(e), e
        assert not os.path.exists(blocker), "the downloaded part is removed"
    finally:
        FAKE["downloads"] = []
        if os.path.isdir(blocker):
            os.rmdir(blocker)
        if os.path.isdir(target):
            os.rmdir(target)
        elif os.path.exists(target):
            os.remove(target)


def test_unreadable_download_checks_is_removed():
    model = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
    p = os.path.join(os.environ["MCS_SEPARATION_MODELS_DIR"], "download_checks.json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    try:
        with open(p, "w", encoding="utf-8") as f:
            f.write('{"vr_download_list": {"a": ')  # cut off by an earlier build's direct download
        _run_separate(model, _sine(0.2))
        assert not os.path.exists(p), "the library's json.load would fail every model on it"
        with open(p, "w", encoding="utf-8") as f:
            f.write('{"vr_download_list": {}}')
        _run_separate(model, _sine(0.2))
        assert os.path.exists(p), "a readable download_checks.json is kept"
    finally:
        if os.path.exists(p):
            os.remove(p)


def test_separate_library_exit_becomes_node_error():
    # audio-separator 0.47.0 mdxc_separator.load_model: `except RuntimeError as e: ... sys.exit(1)`
    def exits_after(error):
        def run():
            try:
                raise error
            except RuntimeError:
                sys.exit(1)

        return run

    mm = nodes.comfy.model_management
    oom_type = getattr(mm, "OOM_EXCEPTION", torch.cuda.OutOfMemoryError)  # what ComfyUI unloads its models for
    model = "vocals_mel_band_roformer.ckpt"
    cases = (
        ("on_load", RuntimeError("PytorchStreamReader failed reading zip archive: failed finding central directory"), RuntimeError, "読み込めませんでした"),
        ("on_load", torch.cuda.OutOfMemoryError("CUDA out of memory. Tried to allocate 2.00 GiB"), torch.cuda.OutOfMemoryError, "VRAM"),
        # RoformerLoader turns the OOM into a message, then mdxc raises RuntimeError(error_msg)
        ("on_load", RuntimeError("Failed to load model: CUDA out of memory. Tried to allocate 2.00 GiB"), torch.cuda.OutOfMemoryError, "VRAM"),
        ("on_separate", RuntimeError("fake"), RuntimeError, "異常終了"),
    )
    try:
        for hook, error, want, text in cases:
            FAKE[hook] = exits_after(error)
            before = len(CREATED_DIRS)
            e = _separate_error(model, _sine(0.2))
            FAKE[hook] = None
            assert type(e) is want and text in str(e), (error, repr(e))
            assert isinstance(e.__cause__, SystemExit), repr(e.__cause__)
            if want is RuntimeError and hook == "on_load":
                assert os.path.join(os.environ["MCS_SEPARATION_MODELS_DIR"], model) in str(e), "names the file to delete"
            if want is not RuntimeError:
                assert isinstance(e, oom_type), repr(e)
            work = CREATED_DIRS[before:]
            assert len(work) == 1 and not os.path.exists(work[0]), "work dir must be removed on errors"
    finally:
        FAKE["on_load"] = FAKE["on_separate"] = None


def test_separate_stops_on_interrupt():
    try:
        from tqdm import tqdm
    except ImportError:
        raise Skip("tqdm not installed")
    mm = nodes.comfy.model_management
    model = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
    steps = []

    def chunks():  # audio-separator's Roformer / Demucs loops: one tqdm step per chunk
        for k in tqdm(range(10), disable=True):
            steps.append(k)
            if k == 2:
                mm.interrupt_current_processing(True)  # キャンセル (POST /interrupt) while separating

    orig_iter = tqdm.__iter__
    try:
        FAKE["on_separate"] = chunks
        before = len(CREATED_DIRS)
        e = _separate_error(model, _sine(0.2))
        assert isinstance(e, mm.InterruptProcessingException), repr(e)
        assert steps == [0, 1, 2], steps
        assert tqdm.__iter__ is orig_iter, "tqdm must be restored after the run"
        work = CREATED_DIRS[before:]
        assert len(work) == 1 and not os.path.exists(work[0]), "work dir must be removed on errors"
        # キャンセル while the model loads (or downloads): the separation does not start
        steps.clear()
        FAKE["on_load"] = lambda: mm.interrupt_current_processing(True)
        e = _separate_error(model, _sine(0.2))
        assert isinstance(e, mm.InterruptProcessingException) and steps == [], (repr(e), steps)
        # outside a separation tqdm does not look at the flag
        FAKE["on_load"] = None
        mm.interrupt_current_processing(True)
        assert list(tqdm(range(3), disable=True)) == [0, 1, 2]
    finally:
        FAKE["on_separate"] = FAKE["on_load"] = None
        mm.interrupt_current_processing(False)


def test_separate_downmixes_5_1_and_refuses_other_layouts():
    model = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
    g = torch.Generator().manual_seed(3)
    x = 0.1 * torch.randn(1, 6, 4410, generator=g)  # FL FR FC LFE BL BR, as LoadAudio decodes a 5.1 file
    v, i = _run_separate(model, x)
    k = 0.5**0.5
    want = torch.stack((x[0, 0] + k * (x[0, 2] + x[0, 4]), x[0, 1] + k * (x[0, 2] + x[0, 5]))).T.numpy()
    got = FAKE["input"]  # what the separator read from input.wav
    assert got.shape == want.shape and np.allclose(got, want, atol=1e-6), got.shape
    assert tuple(v["waveform"].shape) == tuple(i["waveform"].shape) == (1, 2, 4410)
    for ch in (3, 4, 8):
        before = len(CREATED_DIRS)
        e = _separate_error(model, torch.zeros(1, ch, 100))
        assert isinstance(e, ValueError) and f"{ch}ch" in str(e) and "ステレオ" in str(e), repr(e)
        assert len(CREATED_DIRS) == before, "refused before creating the work dir"


def test_separate_multi_stem_loud_input_keeps_balance():
    # Decoded lossy masters peak above 0 dBFS; the library's writer must not scale one stem (the drums) on its own
    # before the stems are summed into the instrumental.
    orig = STEMS["htdemucs_ft.yaml"]
    n = 22050
    half = n // 2

    def in_half(gain, first):
        def stem(d):  # d: (frames, ch)
            out = np.zeros_like(d)
            sl = slice(0, half) if first else slice(half, None)
            out[sl] = gain * d[sl]
            return out

        return stem

    STEMS["htdemucs_ft.yaml"] = [("Bass", in_half(0.5, True)), ("Drums", in_half(0.9, False)), ("Other", 0.1), ("Vocals", 0.2)]
    try:
        x = _sine(n / 44100, amp=1.3)
        v, i = _run_separate("htdemucs_ft.yaml", x)
        want = x.clone()
        want[..., :half] *= 0.6  # bass + other; the second half is drums + other = 1.0
        want = want * (0.9 / float(want.abs().max()))  # the 0.9 output limit on the summed instrumental
        assert torch.allclose(i["waveform"], want, atol=1e-5), float((i["waveform"] - want).abs().max())
        assert torch.allclose(v["waveform"], x * 0.2, atol=1e-5), "vocals (peak 0.26) stay at the input's level"
        assert float(np.abs(FAKE["input"]).max()) <= nodes._MULTI_STEM_INPUT_PEAK + 1e-6
    finally:
        STEMS["htdemucs_ft.yaml"] = orig


def test_save_wav_clamps_and_rejects_nonfinite():
    out = _real_mkdtemp()
    orig = folder_paths.get_output_directory
    folder_paths.get_output_directory = lambda: out
    try:
        x = torch.tensor([[[0.5, 1.5, -2.0, 1.0], [0.0, -0.25, 3.0, -1.0]]])
        res = nodes.MCS_SaveAudioWav().save(_audio(x, 48000), "audio/test")
        item = res["ui"]["audio"][0]
        path = os.path.join(out, item["subfolder"], item["filename"])
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        assert sr == 48000 and sf.info(path).subtype == "FLOAT"
        expect = x[0].clamp(-1, 1).T.numpy()
        assert np.array_equal(data, expect), data
        for bad in (float("nan"), float("inf")):
            try:
                nodes.MCS_SaveAudioWav().save(_audio(torch.tensor([[[0.0, bad]]])), "audio/test")
                raise AssertionError("expected ValueError")
            except ValueError:
                pass
    finally:
        folder_paths.get_output_directory = orig
        shutil.rmtree(out, ignore_errors=True)


def test_audio_info():
    x = torch.tensor([[[0.5, 1.00488, -0.25, 0.0]]])
    res = nodes.MCS_AudioInfo().info(_audio(x, 4))
    info = json.loads(res["result"][0])
    assert info["peak"] == 1.00488 and info["clipped_samples"] == 1 and info["seconds"] == 1.0, info
    assert res["ui"]["text"][0] == res["result"][0]
    for bad in (torch.zeros(2, 1, 4), torch.tensor([[[0.0, float("nan")]]])):
        try:
            nodes.MCS_AudioInfo().info(_audio(bad))
            raise AssertionError("expected ValueError")
        except ValueError:
            pass


def test_yue2_status():
    cond = [[torch.zeros(1, 2, 3), {"yue2_frames": 250, "yue2_truncated": True, "yue2_chunks": ()}]]
    res = nodes.MCS_YuE2Status().status(cond)
    st = json.loads(res["result"][0])
    assert st == {"frames": 250, "seconds": 10.0, "truncated": True, "valid": True}, st
    assert res["ui"]["text"] == [res["result"][0]]
    st = json.loads(nodes.MCS_YuE2Status().status([[torch.zeros(1), {}]])["result"][0])
    assert st == {"frames": 0, "seconds": 0.0, "truncated": False, "valid": False}, st
    assert "MCS_YuE2Status" in mcs_yue2_nodes.NODE_CLASS_MAPPINGS
    assert "MCS_YuE2Status" in mcs_yue2_nodes.NODE_DISPLAY_NAME_MAPPINGS
    assert nodes.MCS_YuE2Status.OUTPUT_NODE is True


class _FakeCTC(torch.nn.Module):
    """wav2vec2-like framing (receptive field 400, hop 320) with purely local outputs."""

    def __init__(self):
        super().__init__()
        torch.manual_seed(0)
        self.conv = torch.nn.Conv1d(1, 8, kernel_size=400, stride=320, bias=False)

    def forward(self, wav):
        return self.conv(wav.unsqueeze(1)).transpose(1, 2), None


def test_chunked_emission_matches_single_pass():
    model = _FakeCTC().eval()
    sr = 16000
    g = torch.Generator().manual_seed(1)
    for seconds in (2.4, 20.0, 33.0, 33.02, 61.7, 95.3, 180.0):
        wav = torch.randn(1, int(seconds * sr), generator=g)
        with torch.inference_mode():
            full, _ = model(wav)
            chunked = nodes._chunked_emission(model, wav, "cpu", 320, sr)
        assert chunked.shape == full.shape, (seconds, chunked.shape, full.shape)
        assert torch.allclose(chunked, full, atol=1e-5), seconds
    # context below one hop is raised to one hop, so no frame is lost per window
    wav = torch.randn(1, int(61.7 * sr), generator=g)
    with torch.inference_mode():
        full, _ = model(wav)
        for ctx in (0, 0.001):
            chunked = nodes._chunked_emission(model, wav, "cpu", 320, sr, segment_seconds=10, context_seconds=ctx)
            assert chunked.shape == full.shape and torch.allclose(chunked, full, atol=1e-5), ctx


def test_chunked_emission_stops_on_interrupt():
    # MCS_AlignLyrics is the last node of the alignment: ComfyUI would never look at the flag again
    mm = nodes.comfy.model_management
    calls = []

    class Cancelling(_FakeCTC):
        def forward(self, wav):
            calls.append(int(wav.shape[1]))
            mm.interrupt_current_processing(True)  # キャンセル while the first window runs
            return super().forward(wav)

    try:
        with torch.inference_mode():
            nodes._chunked_emission(Cancelling().eval(), torch.zeros(1, 70 * 16000), "cpu", 320, 16000)
        raise AssertionError("expected InterruptProcessingException")
    except mm.InterruptProcessingException:
        pass
    finally:
        mm.interrupt_current_processing(False)
    assert len(calls) == 1, f"windows run after the interrupt: {calls}"


def test_romanization_tokens():
    toks = [t for t, _ in nodes._romanize_line("Don't stop 'cause rock\u2019n\u2019roll", "en")]
    assert toks == ["don't", "stop", "cause", "rock'n'roll"], toks
    assert nodes._romanize_line("123 ♪", "other") == []  # nothing to read (Hangul etc.: test_romanization_uroman)
    try:
        import pykakasi  # noqa: F401
    except ImportError:
        raise Skip("pykakasi not installed: ja particle check skipped")
    ja = nodes._romanize_line("君は夜空を見上げた", "ja")
    assert ("o", "を") in ja, ja
    # を inside a kana run (the hiragana sung-text path) is "o" too; the word text stays the original
    assert nodes._romanize_line("あなたをまってる", "ja") == [("anataomatteru", "あなたをまってる")]
    assert ("otsunaide", "をつないで") in nodes._romanize_line("手をつないで", "ja")
    assert ("otaku", "ヲタク") in nodes._romanize_line("ヲタク", "ja")
    # Hepburn's syllable apostrophe is not an extra CTC token for Japanese
    assert nodes._romanize_line("きんえん", "ja") == [("kinen", "きんえん")]


def test_romanization_ja_latin_words():
    try:
        import pykakasi  # noqa: F401
    except ImportError:
        raise Skip("pykakasi not installed")
    # English inside Japanese lines: one entry per word (not one per phrase), no trailing spaces
    out = nodes._romanize_line("Baby I love you 君が好き", "ja")
    assert out[:4] == [("baby", "Baby"), ("i", "I"), ("love", "love"), ("you", "you")], out
    assert all(w == w.strip() for _, w in out) and [t for t, _ in out[4:]] == ["kun", "ga", "suki"], out
    # inner apostrophes stay inside the word (MMS_FA has a "'" token)
    out = nodes._romanize_line("I'm 恋して don’t stop", "ja")
    assert out[0] == ("i'm", "I'm") and out[-2:] == [("don't", "don’t"), ("stop", "stop")], out
    # full-width letters typed with the IME are one word, not one entry per letter
    assert nodes._romanize_line("LOVE ＬＯＶＥ", "ja") == [("love", "LOVE"), ("love", "ＬＯＶＥ")]
    assert nodes._romanize_line("君と Dancing 踊ろう", "ja")[:3] == [("kun", "君"), ("to", "と"), ("dancing", "Dancing")]
    # a Japanese line without Latin keeps its pykakasi items
    assert nodes._romanize_line("人々は", "ja") == [("hitobito", "人々"), ("ha", "は")]
    # Latin letters NFKD cannot fold stay inside their word (one run, one entry), not split off as foreign
    assert nodes._script_runs("Straße 君と") == [("Straße ", "latin"), ("君と", "ja")]
    assert nodes._romanize_line("Straße 君と", "ja")[0] == ("strasse", "Straße")
    # a quoted word keeps both quotes in its text (as on the en path); the tokens have none
    assert nodes._romanize_line("明日へ \u2018Go\u2019", "ja")[-1] == ("go", "\u2018Go\u2019")
    assert nodes._romanize_line("'Hello' 君", "ja")[0] == ("hello", "'Hello'")
    # a g-dropped word keeps its apostrophe
    assert nodes._romanize_line("lovin' 君", "ja")[0] == ("lovin", "lovin'")


def test_romanization_ja_symbols_add_no_words():
    try:
        import pykakasi  # noqa: F401
    except ImportError:
        raise Skip("pykakasi not installed")
    rl = lambda t: nodes._romanize_line(t, "ja")  # noqa: E731
    # pykakasi 2.3 repeats the previous item after an emoji, NBSP or half-width ｡､｢｣: the aligner would get a
    # word that was never sung
    assert rl("ありがとう😊") == rl("ありがとう👍🏻") == rl("ありがとう🇯🇵") == rl("ありがとう") == [("arigatou", "ありがとう")]
    assert rl("きみがすき🎵") == rl("きみがすき")
    assert rl("君は😀夜空") == rl("君は") + rl("夜空")
    assert rl("あなた だけ") == rl("あなた") + rl("だけ")
    assert rl("あいしてる｡") == rl("あいしてる")
    assert rl("あいしてる､だいすき") == rl("あいしてる") + rl("だいすき")
    assert rl("ずっと｢すき｣") == rl("ずっと") + rl("すき")
    assert rl("あいしてる。♪") == rl("あいしてる")  # common lyric symbols: unchanged
    # Japanese characters pykakasi 2.3 has no branch for repeat the previous item too (ありがとうヾ -> ありがとう,
    # ヾ, ありがとう): ヽヾヿ (kaomoji such as ヾ(…)) and the compatibility kanji NFC keeps (﨎) are left out;
    # the half-width ﾟ (ﾊﾟ), the small katakana ㇰ-ㇿ and 﨑 are read as パ, ク … and 崎
    words = lambda t: "".join(w for _, w in rl(t))  # noqa: E731
    assert rl("ありがとうヾ") == rl("ありがとうヽ") == rl("ありがとうヿ") == rl("ありがとう"), rl("ありがとうヾ")
    assert rl("やったーヽ(´▽｀)") == rl("やったー")
    assert rl("君﨎") == rl("君")
    assert words("ﾊﾟﾗﾀﾞｲｽ") == "パラダイス" and rl("ﾊﾟﾗﾀﾞｲｽ") == rl("パラダイス"), rl("ﾊﾟﾗﾀﾞｲｽ")
    assert words("ｽﾋﾟｰﾄﾞ") == "スピード", rl("ｽﾋﾟｰﾄﾞ")
    assert words("山﨑") == "山崎" and rl("山﨑") == rl("山崎"), rl("山﨑")
    assert words("ありがとうㇰ") == "ありがとうク", rl("ありがとうㇰ")
    # decomposed (NFD) kana: が is not read as か
    nfd = unicodedata.normalize("NFD", "がっこう")
    assert nfd != "がっこう" and rl(nfd) == rl("がっこう"), rl(nfd)
    assert len(rl("がっこう")) == 1 and rl("がっこう")[0][0].startswith("ga"), rl("がっこう")


def test_romanization_zh_phrase_context():
    try:
        import pypinyin  # noqa: F401
    except ImportError:
        raise Skip("pypinyin not installed")
    rz = lambda t: nodes._romanize_line(t, "zh")  # noqa: E731
    # the reading comes from the phrase (per character: yin le / zhong xin / shui jue), one word per character
    assert rz("音乐会") == [("yin", "音"), ("yue", "乐"), ("hui", "会")]
    assert rz("重新") == [("chong", "重"), ("xin", "新")]
    assert rz("睡觉吧！") == [("shui", "睡"), ("jiao", "觉"), ("ba", "吧")]
    assert rz("我们的音乐") == [("wo", "我"), ("men", "们"), ("de", "的"), ("yin", "音"), ("yue", "乐")]
    # ü is u for the CTC dictionary (pypinyin's default style writes v)
    assert rz("女孩") == [("nu", "女"), ("hai", "孩")]
    # Latin letters in a zh line stay one per letter (the app's per-character rule relies on it)
    assert rz("我爱你 baby") == [("wo", "我"), ("ai", "爱"), ("ni", "你"), ("b", "b"), ("a", "a"), ("b", "b"), ("y", "y")]


def test_romanization_latin_extra_without_uroman():
    restore = _without_modules(["uroman"])
    cached = nodes._aligner_cache.pop("uroman", None)
    try:
        for word, want in (("Straße", ["strasse"]), ("Ærø", ["aeroe"]), ("cœur", ["coeur"]), ("łza", ["lza"]), ("Đorđe", ["dorde"]), ("ırmak", ["irmak"]), ("þing", ["thing"])):
            missing = []
            assert nodes._romanized_tokens(word, word, missing) == want and missing == [], (word, missing)
        missing = []
        assert nodes._romanize_line("heiß und groß", "other", missing) == [("heiss", "heiß"), ("und", "und"), ("gross", "groß")] and missing == []
    finally:
        restore()
        if cached is not None:
            nodes._aligner_cache["uroman"] = cached


def _uroman_installed():
    try:
        import uroman  # noqa: F401

        return True
    except ImportError:
        return False


def _without_modules(names):
    """Make `import <name>` raise ImportError for each name; returns what restores sys.modules."""
    saved = {k: sys.modules.get(k) for k in names}
    for k in names:
        sys.modules[k] = None

    def restore():
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    return restore


def test_romanization_uroman():
    if not _uroman_installed():
        raise Skip("uroman not installed: multilingual romanization skipped")
    # Korean and Cyrillic lines ("other" / "en"); the word text stays the original, punctuation included
    assert nodes._romanize_line("사랑해 우리", "other") == [("saranghae", "사랑해"), ("uri", "우리")]
    assert nodes._romanize_line("Привет, мир!", "other") == [("privet", "Привет,"), ("mir", "мир!")]
    assert nodes._romanize_line("Καλημέρα 123", "other") == [("kalemera", "Καλημέρα")]
    # a Cyrillic word inside English lyrics, and a word mixing both scripts
    assert nodes._romanize_line("Hello Привет", "en") == [("hello", "Hello"), ("privet", "Привет")]
    assert nodes._romanize_line("Rock'n'Ролл", "en") == [("rock'n'roll", "Rock'n'Ролл")]
    # Latin text keeps the existing folding (uroman is not consulted for it); ß goes through uroman
    assert [t for t, _ in nodes._romanize_line("Don't stop café", "other")] == ["don't", "stop", "cafe"]
    assert nodes._romanize_line("Straße", "other") == [("strasse", "Straße")]
    assert nodes._aligner_cache.get("uroman") is not None, "the Uroman instance must be cached"
    # foreign words inside Japanese / Chinese lines: the primary romanizers keep their own output
    try:
        import pykakasi  # noqa: F401

        assert nodes._romanize_line("君は 사랑해", "ja") == [("kun", "君"), ("ha", "は"), ("saranghae", "사랑해")]
        assert nodes._romanize_line("あなたを사랑해", "ja") == [("anatao", "あなたを"), ("saranghae", "사랑해")]
        assert nodes._romanize_line("人々は", "ja") == [("hitobito", "人々"), ("ha", "は")]
    except ImportError:
        print("  (pykakasi not installed: ja mixed-script check skipped)")
    try:
        import pypinyin  # noqa: F401

        assert nodes._romanize_line("我 사랑해", "zh") == [("wo", "我"), ("sa", "사"), ("rang", "랑"), ("hae", "해")]
    except ImportError:
        print("  (pypinyin not installed: zh mixed-script check skipped)")


def test_romanization_uroman_fallback_without_pykakasi_pypinyin():
    if not _uroman_installed():
        raise Skip("uroman not installed: fallback check skipped")
    restore = _without_modules(["pykakasi", "pypinyin"])
    kks = nodes._aligner_cache.pop("kakasi", None)
    try:
        assert nodes._romanize_line("あなたをまってる", "ja") == [("anataomatteru", "あなたをまってる")]
        assert nodes._romanize_line("きんえん 123", "ja") == [("kinen", "きんえん")]
        assert nodes._romanize_line("我爱你 baby", "zh") == [("wo", "我"), ("ai", "爱"), ("ni", "你"), ("b", "b"), ("a", "a"), ("b", "b"), ("y", "y")]
    finally:
        restore()
        if kks is not None:
            nodes._aligner_cache["kakasi"] = kks


def test_romanization_without_uroman():
    restore = _without_modules(["uroman"])
    cached = nodes._aligner_cache.pop("uroman", None)
    try:
        missing = []
        assert nodes._romanize_line("사랑해 123", "other", missing) == [] and missing == ["사랑해"], missing
        missing = []
        assert nodes._romanize_line("Hello Привет", "en", missing) == [("hello", "Hello")] and missing == ["Привет"], missing
        # a word mixing scripts keeps its Latin part like before; it lost letters, so it is reported too
        missing = []
        assert nodes._romanize_line("Rock'n'Ролл", "en", missing) == [("rock'n", "Rock'n'Ролл")] and missing == ["Rock'n'Ролл"], missing
        assert nodes._romanize_line("사랑해", "other") == []
        # the node skips such lines before touching the model and warns once per run with the line numbers
        records = []
        handler = logging.Handler()
        handler.emit = lambda r: records.append(r.getMessage())
        logging.getLogger().addHandler(handler)
        try:
            res = nodes.MCS_AlignLyrics().align(_audio(torch.zeros(1, 1, 16000)), "[verse]\n사랑해\n\n안녕", "other")
        finally:
            logging.getLogger().removeHandler(handler)
        assert res["result"] == ("[]",), res
        warned = [m for m in records if "uroman" in m]
        assert len(warned) == 1 and "2 行をスキップ（2, 4 行目）" in warned[0], records
    finally:
        restore()
        if cached is not None:
            nodes._aligner_cache["uroman"] = cached


def test_align_is_changed_follows_installed_romanizers():
    import importlib.util

    orig = importlib.util.find_spec
    try:
        importlib.util.find_spec = lambda name, *a, **kw: None if name == "uroman" else orig(name, *a, **kw)
        without = nodes.MCS_AlignLyrics.IS_CHANGED(lyrics="x", language="ja")
        importlib.util.find_spec = lambda name, *a, **kw: object() if name in ("uroman", "pykakasi", "pypinyin") else orig(name, *a, **kw)
        with_all = nodes.MCS_AlignLyrics.IS_CHANGED(lyrics="x", language="ja")
    finally:
        importlib.util.find_spec = orig
    assert "uroman" not in without.split(",") and with_all == "pykakasi,pypinyin,uroman", (without, with_all)
    assert without != with_all
    # stable while nothing is installed or removed, so ComfyUI keeps using its cache
    assert nodes.MCS_AlignLyrics.IS_CHANGED() == nodes.MCS_AlignLyrics.IS_CHANGED()


def test_ctc_budget():
    # adjacent equal tokens need a blank between them, also across word / line boundaries ("tt", "nn")
    assert nodes._ctc_need([1, 2, 2, 3]) == 5
    assert nodes._ctc_need([2, 3], prev=2) == 3
    lines = [[1, 2], [2, 3], [4, 4], [5]]  # need 2, 3 (2 after 2), 3 (4 4), 1 -> cumulative 2, 5, 8, 9
    assert nodes._lines_that_fit(lines, 18) == 4  # 9 <= 18 * 0.5
    assert nodes._lines_that_fit(lines, 16) == 3  # 8 <= 8, 9 > 8
    assert nodes._lines_that_fit(lines, 10) == 2  # 5 <= 5
    assert nodes._lines_that_fit([[1, 2, 3, 4, 5, 6]], 8) == 1  # over the budget but it fits the frames
    assert nodes._lines_that_fit([[1, 2, 3, 4, 5, 6], [7]], 8) == 1
    assert nodes._lines_that_fit([[1, 2, 3, 4, 5, 6]], 5) == 0  # not even the first line


class _FakeTokenizer:
    def __call__(self, words):
        return [[ord(c) - 96 for c in w if c.isalpha()] or [27] for w in words]


class _FakeAligner:
    """One span per token, frames laid out word after word from frame 10 (the real aligner needs weights)."""

    def __init__(self):
        self.calls = []

    def __call__(self, emission, tokens):
        import torchaudio

        self.calls.append((int(emission.shape[0]), [list(t) for t in tokens]))
        out, f = [], 10
        for t in tokens:
            spans = []
            for tok in t:
                spans.append(torchaudio.functional.TokenSpan(token=tok, start=f, end=f + 1, score=0.5))
                f += 1
            out.append(spans)
        return out


def _with_fake_mms(fn):
    saved = {k: nodes._aligner_cache.get(k) for k in ("model", "tokenizer", "aligner")}
    aligner = _FakeAligner()
    nodes._aligner_cache.update(model=_FakeCTC().eval(), tokenizer=_FakeTokenizer(), aligner=aligner)
    try:
        return fn(aligner)
    finally:
        for k, v in saved.items():
            if v is None:
                nodes._aligner_cache.pop(k, None)
            else:
                nodes._aligner_cache[k] = v


def test_align_result_assembly_without_model():
    def run(aligner):
        res = nodes.MCS_AlignLyrics().align(_audio(torch.zeros(1, 1, 16000), 16000), "[verse]\nhello world\n\ndon't stop", "en")
        out = json.loads(res["result"][0])
        assert res["ui"]["text"] == [res["result"][0]]
        # 1 s at 16 kHz -> 49 frames for the fake model (receptive field 400, hop 320)
        assert aligner.calls[0][0] == 49 and len(aligner.calls[0][1]) == 4
        # frames: hello 10-15, world 15-20, don't 20-24 (the fake drops "'"), stop 24-28; 0.02 s per frame
        assert out == [
            {"line": "hello world", "start": 0.2, "end": 0.4, "index": 1,
             "words": [{"text": "hello", "start": 0.2, "end": 0.3, "score": 0.5}, {"text": "world", "start": 0.3, "end": 0.4, "score": 0.5}]},
            {"line": "don't stop", "start": 0.4, "end": 0.56, "index": 3,
             "words": [{"text": "don't", "start": 0.4, "end": 0.48, "score": 0.5}, {"text": "stop", "start": 0.48, "end": 0.56, "score": 0.5}]},
        ], out

    _with_fake_mms(run)


def test_align_short_audio_aligns_what_fits():
    long_line = "abcdefghij klmnopqrst"  # 20 tokens

    def run(aligner):
        records = []
        handler = logging.Handler()
        handler.emit = lambda r: records.append(r.getMessage())
        logging.getLogger().addHandler(handler)
        try:
            # 49 frames: budget 24.5 -> the first line (20 tokens) fits, the other two do not
            res = nodes.MCS_AlignLyrics().align(_audio(torch.zeros(1, 1, 16000), 16000), f"{long_line}\n[chorus]\n{long_line}\nlast", "en")
        finally:
            logging.getLogger().removeHandler(handler)
        out = json.loads(res["result"][0])
        assert [e["index"] for e in out] == [0, 2, 3], out
        assert len(aligner.calls[0][1]) == 2, "only the first line's words are aligned"
        assert out[0]["words"][0]["score"] == 0.5
        for e in out[1:]:  # not in the audio: at its end, score 0 (the app estimates these lines, grey)
            assert e["start"] == e["end"] == 0.98 and all(w["score"] == 0.0 for w in e["words"]), e
        assert [w["text"] for w in out[1]["words"]] == ["abcdefghij", "klmnopqrst"]
        assert any("先頭の 1 行だけ" in m for m in records), records
        # not even the first line fits: a Japanese error instead of torch's CTC message
        try:
            nodes.MCS_AlignLyrics().align(_audio(torch.zeros(1, 1, 8000), 16000), long_line + long_line, "en")
            raise AssertionError("expected ValueError")
        except ValueError as e:
            assert "音声が短すぎて歌詞を整列できません" in str(e), e
        # less than one receptive field of audio
        try:
            nodes.MCS_AlignLyrics().align(_audio(torch.zeros(1, 1, 300), 16000), "hello", "en")
            raise AssertionError("expected ValueError")
        except ValueError as e:
            assert "短すぎます" in str(e), e

    _with_fake_mms(run)


def test_write_wav_float32_one_copy_layout():
    d = _real_mkdtemp()
    try:
        p = os.path.join(d, "x.wav")
        x = np.array([[0.25, -0.5, 0.125], [1.0, 0.0, -1.0]], dtype=np.float64)  # (channels, frames), not float32
        nodes._write_wav_float32(p, x, 22050)
        data, sr = sf.read(p, dtype="float32", always_2d=True)
        assert sr == 22050 and sf.info(p).subtype == "FLOAT" and np.array_equal(data, x.T.astype(np.float32)), data
        with open(p, "rb") as f:
            raw = f.read()
        assert len(raw) == 8 + int.from_bytes(raw[4:8], "little") and raw[-24:] == x.T.astype(np.float32).tobytes()
        nodes._write_wav_float32(p, np.zeros((1, 0), np.float32), 48000)  # empty audio still writes a valid header
        assert sf.info(p).frames == 0
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _mms_torch_home():
    for d in (os.environ.get("MCS_TORCH_HOME"), os.path.join(os.environ["MCS_DATA_ROOT"], "models", "torch") if os.environ.get("MCS_DATA_ROOT") else None, "C:/MCSYuE2/models/torch"):
        if d and os.path.isfile(os.path.join(d, "hub", "checkpoints", "model.pt")):
            return d
    return None


def test_real_mms_fa():
    home = _mms_torch_home()
    if ARGS.no_model or home is None:
        raise Skip("MMS_FA weights not cached (or --no-model)")
    # Only MCS_TORCH_HOME: the node hands it to torch.hub itself (dl_kwargs), TORCH_HOME is not needed.
    os.environ["MCS_TORCH_HOME"] = home
    from torchaudio.pipelines import MMS_FA as bundle

    assert "'" in bundle.get_dict(), "MMS_FA dictionary must contain the apostrophe"
    bundle.get_tokenizer()(["don't"])  # must not raise KeyError
    model = bundle.get_model(with_star=False, dl_kwargs={"model_dir": os.path.join(home, "hub", "checkpoints")}).eval()
    assert nodes._feature_hop(model) == 320
    g = torch.Generator().manual_seed(2)
    for seconds, exact in ((20.0, True), (70.0, False)):
        wav = 0.1 * torch.randn(1, int(seconds * 16000), generator=g)
        with torch.inference_mode():
            full, _ = model(wav)
            chunked = nodes._chunked_emission(model, wav, "cpu", 320, 16000)
        assert chunked.shape == full.shape, (seconds, chunked.shape, full.shape)
        if exact:  # <= 33 s is one window: identical to the single pass
            assert torch.equal(chunked, full), seconds
    del model

    # End to end through the node (ComfyUI's device); the model must be back on the CPU afterwards.
    for k in ("model", "tokenizer", "aligner"):
        nodes._aligner_cache.pop(k, None)
    x = 0.1 * torch.randn(1, 1, 5 * 44100, generator=g)
    res = nodes.MCS_AlignLyrics().align(_audio(x), "[verse]\nhello world\n\ndon't stop", "en")
    out = json.loads(res["result"][0])
    assert [e["index"] for e in out] == [1, 3], out
    for e in out:
        assert set(e) >= {"line", "start", "end", "words", "index"} and 0 <= e["start"] <= e["end"] <= 5.0, e
    m = nodes._aligner_cache["model"]
    assert next(m.parameters()).device.type == "cpu", "MMS_FA must be offloaded to the CPU after a run"
    try:
        nodes.MCS_AlignLyrics().align(_audio(torch.zeros(2, 1, 16000)), "hello", "en")
        raise AssertionError("expected ValueError for batch 2")
    except ValueError:
        pass


def main():
    tests = [(k, v) for k, v in globals().items() if k.startswith("test_") and callable(v)]
    failed = 0
    skipped = 0
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except Skip as s:
            skipped += 1
            print(f"SKIP {name}: {s}")
        except (Exception, nodes.comfy.model_management.InterruptProcessingException):  # a BaseException in ComfyUI
            failed += 1
            nodes.comfy.model_management.interrupt_current_processing(False)  # a stray cancel must not fail later tests
            print(f"FAIL {name}")
            traceback.print_exc()
    leftovers = [d for d in CREATED_DIRS if os.path.exists(d)]
    for d in leftovers:
        shutil.rmtree(d, ignore_errors=True)
    if leftovers:
        failed += 1
        print(f"FAIL temp dirs left behind: {leftovers}")
    if not INSTALL_SEP_DIR_EXISTED and os.path.exists(INSTALL_SEP_DIR):
        failed += 1
        print(f"FAIL the tests created {INSTALL_SEP_DIR} in the ComfyUI installation")
    if INSTALL_SEP_TREE is not None and _tree(INSTALL_SEP_DIR) != INSTALL_SEP_TREE:
        failed += 1
        print(f"FAIL the tests changed {INSTALL_SEP_DIR} in the ComfyUI installation")
    shutil.rmtree(TEST_ROOT, ignore_errors=True)
    print(f"{len(tests)} tests, {failed} failure(s), {skipped} skipped")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
