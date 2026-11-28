/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

for (const name of Object.keys(process.env)) if (name.startsWith('SOLPI_')) delete process.env[name];

export const builtinTools = () => [{ name: 'bash', promptGuidelines: ['Use bash for shell commands.'], sourceInfo: { source: 'builtin', path: 'builtin:bash' } }];
