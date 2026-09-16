#!/usr/bin/env python3
"""Shrink Soroban contract WASMs for cheaper mainnet upload.

Upload cost on mainnet is dominated by storage rent for the code entry,
which is proportional to the WASM byte size (~1.4 XLM/KB at current rates).
This pipeline applies only behavior-preserving transforms:

  1. wasm-opt -Oz --converge, restricted to the feature set the Soroban VM
     accepts (MVP + sign-ext + mutable-globals). Deeper than the plain -Oz
     that `stellar contract optimize` runs.
  2. Blanks doc strings inside the contractspecv0 custom section. The
     interface (function/arg/type/error names) is preserved byte-exact,
     so CLI invocation and TS-bindings generation keep working.

contractenvmetav0 (required by the host) is always kept.

With --strip-spec, contractspecv0 and contractmetav0 are removed entirely
(~4-7 KB per contract). Execution is unaffected, but explorers and
`stellar contract invoke` can no longer discover the ABI from the chain —
keep the un-stripped wasm around for bindings generation and verification.

Usage:
  python3 optimize-wasm.py [--strip-spec] IN.wasm OUT.wasm
  python3 optimize-wasm.py [--strip-spec] --all TARGET_DIR OUT_DIR
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

WASM_OPT_FLAGS = [
    "--mvp-features",
    "--enable-sign-ext",
    "--enable-mutable-globals",
    # LLVM never places data below address 1024 in Rust-emitted wasm,
    # letting binaryen fold constant offsets into load/store immediates.
    "--low-memory-unused",
    "-Oz",
    "--converge",
]

CONTRACTS = [
    "perp_vault",
    "perp_engine",
    "perp_order_gateway",
    "perp_risk",
    "perp_oracle_adapter",
    "perp_insurance",
    "perp_liquidation",
    "perp_governance",
]


def read_uleb(data: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        b = data[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def write_uleb(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def split_sections(wasm: bytes) -> list[tuple[int, str | None, bytes]]:
    """Returns [(section_id, custom_name_or_None, full_body)]."""
    assert wasm[:8] == b"\0asm\x01\0\0\0", "not a wasm v1 module"
    sections = []
    i = 8
    while i < len(wasm):
        sid = wasm[i]
        i += 1
        size, i = read_uleb(wasm, i)
        body = wasm[i : i + size]
        name = None
        if sid == 0:
            nlen, j = read_uleb(body, 0)
            name = body[j : j + nlen].decode()
        sections.append((sid, name, body))
        i += size
    return sections


def join_sections(sections: list[tuple[int, str | None, bytes]]) -> bytes:
    out = bytearray(b"\0asm\x01\0\0\0")
    for sid, _name, body in sections:
        out.append(sid)
        out += write_uleb(len(body))
        out += body
    return bytes(out)


def blank_docs(node):
    if isinstance(node, dict):
        return {
            k: ("" if k == "doc" and isinstance(v, str) else blank_docs(v))
            for k, v in node.items()
        }
    if isinstance(node, list):
        return [blank_docs(v) for v in node]
    return node


def strip_spec_docs(spec: bytes) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".bin") as raw, tempfile.NamedTemporaryFile(
        mode="w", suffix=".jsonl"
    ) as jsonl:
        raw.write(spec)
        raw.flush()
        decoded = subprocess.run(
            ["stellar", "xdr", "decode", "--type", "ScSpecEntry",
             "--input", "stream", "--output", "json"],
            stdin=open(raw.name, "rb"), capture_output=True, check=True,
        ).stdout.decode()
        for line in decoded.splitlines():
            jsonl.write(json.dumps(blank_docs(json.loads(line)),
                                   separators=(",", ":")) + "\n")
        jsonl.flush()
        return subprocess.run(
            ["stellar", "xdr", "encode", "--type", "ScSpecEntry",
             "--input", "json", "--output", "stream", jsonl.name],
            capture_output=True, check=True,
        ).stdout


def optimize(src: Path, dst: Path, strip_spec: bool) -> tuple[int, int]:
    before = src.stat().st_size
    with tempfile.NamedTemporaryFile(suffix=".wasm") as tmp:
        subprocess.run(
            ["wasm-opt", *WASM_OPT_FLAGS, str(src), "-o", tmp.name], check=True
        )
        wasm = Path(tmp.name).read_bytes()

    sections = []
    for sid, name, body in split_sections(wasm):
        if sid == 0 and name in ("contractspecv0", "contractmetav0") and strip_spec:
            continue
        if sid == 0 and name == "contractspecv0":
            nlen_prefix = write_uleb(len(name)) + name.encode()
            spec = body[len(nlen_prefix):]
            body = nlen_prefix + strip_spec_docs(spec)
        sections.append((sid, name, body))

    dst.write_bytes(join_sections(sections))
    after = dst.stat().st_size
    return before, after


def main() -> None:
    args = sys.argv[1:]
    strip_spec = "--strip-spec" in args
    args = [a for a in args if a != "--strip-spec"]
    if len(args) == 3 and args[0] == "--all":
        target_dir, out_dir = Path(args[1]), Path(args[2])
        out_dir.mkdir(parents=True, exist_ok=True)
        pairs = [(target_dir / f"{c}.wasm", out_dir / f"{c}.wasm") for c in CONTRACTS]
    elif len(args) == 2:
        pairs = [(Path(args[0]), Path(args[1]))]
    else:
        sys.exit(__doc__)

    if not shutil.which("wasm-opt") or not shutil.which("stellar"):
        sys.exit("error: needs wasm-opt (binaryen) and stellar CLI on PATH")

    total_before = total_after = 0
    for src, dst in pairs:
        before, after = optimize(src, dst, strip_spec)
        total_before += before
        total_after += after
        print(f"{src.name:32s} {before:>7} -> {after:>7} B  (-{before - after})")
    if len(pairs) > 1:
        print(f"{'TOTAL':32s} {total_before:>7} -> {total_after:>7} B  "
              f"(-{total_before - total_after})")


if __name__ == "__main__":
    main()
