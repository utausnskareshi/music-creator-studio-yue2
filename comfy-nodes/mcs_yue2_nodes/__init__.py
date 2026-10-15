"""MCS YuE2 Nodes - helper nodes shipped with Music Creator Studio YuE2.

Installed by the app into ComfyUI/custom_nodes/mcs_yue2_nodes.

Nodes:
- MCS_SaveAudioWav: 32-bit float WAV saver (non-finite check, clamp to [-1, 1] like the official YuE2 pipeline)
- MCS_AudioInfo: duration / sample rate / channels / peak / RMS as JSON
- MCS_VocalSeparate: vocals / instrumental separation with python-audio-separator
- MCS_AlignLyrics: lyric line timestamps with torchaudio MMS_FA forced alignment
- MCS_YuE2Status: YuE2 Generate Music frames and token-budget truncation flag as JSON

Dependencies: torch, torchaudio and numpy come from ComfyUI core. The optional packages are installed by
the app, not by ComfyUI: audio-separator==0.47.0 (brings soundfile) for MCS_VocalSeparate, and
pykakasi / pypinyin for Japanese / Chinese romanization in MCS_AlignLyrics, and uroman==1.3.1.1 for every
other script (Korean, Cyrillic, Greek …; also the fallback when pykakasi / pypinyin are missing). Without
them the node falls back to Latin letters only. The imports are lazy, so the pack always loads.

Environment (set by the app, all optional): MCS_SEPARATION_MODELS_DIR (separation checkpoints),
MCS_TORCH_HOME (MMS_FA weights in <it>/hub/checkpoints), MCS_FFMPEG_DIR (added to PATH for audio-separator),
MCS_TEMP_DIR (root of MCS_VocalSeparate's mcs_sep_* work folders, default: the system temp folder; folders
older than 12 hours, left behind by a killed ComfyUI, are removed on load and before each separation).
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
