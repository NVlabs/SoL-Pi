/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import install, { piPackage } from './extension.js';

export default function(pi) {
  return install(pi, async () => {
    try { return require('@earendil-works/pi-coding-agent'); } catch { return piPackage(); }
  });
}
