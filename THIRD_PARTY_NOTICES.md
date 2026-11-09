# 第三方声明

本仓库包含第三方开源代码/依赖。下列内容随软件分发时保留原始版权与许可声明。

## FFmpeg（随包二进制）

- 来源：FFmpeg 6.1.1-essentials_build（Gyan builds，`https://www.gyan.dev/ffmpeg/builds/`），
  构建时由 `scripts/fetch-ffmpeg.mjs` 取入 `vendor/ffmpeg/ffmpeg.exe`（固定 sha256＋体积双重校验）。
- 使用方式：**内置**在安装包的 `resources/ffmpeg/ffmpeg.exe`，启动时校验指纹后加入 PATH，
  供员工做本地音视频转码/裁切；不做网络推流（外发需老板批准）。
- 许可：**GPL-3.0**（构建含 libx264/libx265 等 GPL 组件）。全文随包：`licenses/ffmpeg-GPL-3.0.txt`；
  声明与对应源码地址：`licenses/ffmpeg-NOTICE.txt`。
- 对应源码：`https://github.com/FFmpeg/FFmpeg`（tag n6.1.1）与 `https://github.com/GyanD/codexffmpeg`（构建脚本）。

## 腾讯官方微信 iLink 传输层（协议移植）

- 来源：`@tencent-weixin/openclaw-weixin` 2.4.10（`github.com/Tencent/openclaw-weixin`）
- 使用方式：`src/main/im/wechat-official.ts` 仅移植 1:1 文本所需的扫码登录、`getupdates` 长轮询、
  `sendmessage`、`context_token` 与 `get_updates_buf` 协议；不包含 OpenClaw 运行时、媒体/群聊链路。
- 许可：MIT

```text
Tencent is pleased to support the open source community by making openclaw-weixin available.

Copyright (C) 2026 Tencent.  All rights reserved.

openclaw-weixin is licensed under the MIT.

Terms of the MIT:
--------------------------------------------------------------------
Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## qrcode

- 来源：npm `qrcode` 1.5.4
- 用途：将微信登录链接渲染为设置页二维码
- 许可：MIT

```text
The MIT License (MIT)

Copyright (c) 2012 Ryan Day

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
