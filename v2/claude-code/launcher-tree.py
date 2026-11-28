# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: MIT
"""List descendants outside Claude's process group before signaling their parents."""
import os
import sys

if sys.platform == 'darwin':
    import ctypes
    children_of = ctypes.CDLL('/usr/lib/libproc.dylib').proc_listchildpids

    def children(pid):
        size = max(32, children_of(pid, None, 0) + 32)
        buffer = (ctypes.c_int * size)()
        count = children_of(pid, buffer, ctypes.sizeof(buffer))
        return buffer[:max(0, count)]
else:
    import subprocess
    by_parent = {}
    for line in subprocess.check_output(['ps', '-A', '-o', 'pid=,ppid=']).splitlines():
        pid, parent = map(int, line.split())
        by_parent.setdefault(parent, []).append(pid)

    def children(pid):
        return by_parent.get(pid, ())


root = int(sys.argv[1])
pending, seen = [root], {root}
while pending:
    for child in children(pending.pop()):
        if child > 0 and child not in seen:
            seen.add(child)
            pending.append(child)
            try:
                if os.getpgid(child) != root:
                    print(child)
            except ProcessLookupError:
                pass
