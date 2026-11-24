# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: MIT
"""Open records relative to a checked directory; never follow a user's symlink."""
import hashlib
import os
from pathlib import Path
import secrets
import stat
import sys
from contextlib import contextmanager


@contextmanager
def directory(path, create=False, private=False):
    path = Path(os.path.abspath(path))
    if sys.platform == 'darwin' and path.parts[1:2] in (('var',), ('tmp',)):
        path = Path('/private', *path.parts[1:])
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    try:
        for part in path.parts[1:]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            # Shared project trees are often group-writable (setgid, owned by root): above the records directory,
            # refuse only other users' directories and world-writable ones without the sticky bit.
            if info.st_uid not in (0, os.getuid()) or (info.st_mode & 0o002 and not info.st_mode & stat.S_ISVTX):
                raise PermissionError('unsafe records directory: ' + str(path))
        info = os.fstat(fd)
        if private and (info.st_uid != os.getuid() or info.st_mode & 0o077):
            raise PermissionError('records directory is not private: ' + str(path))
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise PermissionError('unsafe records directory: ' + str(path))
        yield fd
    finally:
        os.close(fd)


def default_log(name):
    base = Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state')
    project = Path.cwd()
    folder = base / 'sol-pi-v2'
    checkout = next((p for p in (project, *project.parents) if (p / '.git').exists()), None)
    if not base.is_absolute() or checkout in (folder.resolve(), *folder.resolve().parents):
        raise ValueError('set XDG_STATE_HOME to an absolute state directory outside the project')
    with directory(folder, create=True, private=True):
        project_dir = folder / hashlib.sha256(os.fsencode(project)).hexdigest()
        with directory(project_dir, create=True, private=True):
            return project_dir / (name + '.jsonl')


def regular(parent, name, mode):
    flags = os.O_RDWR | os.O_APPEND | os.O_CREAT if mode == 'a+b' else os.O_RDONLY
    fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o022:
        os.close(fd)
        raise PermissionError('unsafe records file: ' + name)
    return os.fdopen(fd, mode)


def open_record(path, mode):
    path = Path(path)
    with directory(path.parent) as parent:
        return regular(parent, path.name, mode)


@contextmanager
def replacement(path):
    path = Path(path)
    with directory(path.parent) as parent:
        try:
            regular(parent, path.name, 'rb').close()
        except FileNotFoundError:
            pass
        name = '.solpi-' + secrets.token_hex(16)
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, 'w') as output:
                yield output
            os.replace(name, path.name, src_dir_fd=parent, dst_dir_fd=parent)
        except BaseException:
            try:
                os.unlink(name, dir_fd=parent)
            except FileNotFoundError:
                pass
            raise
