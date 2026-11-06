/**
 * 官方 B 运输层单测：扫码、长轮询、发文本、context_token 与 -14 登录态失效。
 * 全部走注入 fetch，不打真实微信；真机扫码单独记录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { OfficialWechatClient } from '../src/main/im/wechat-official.js';

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch(
  handler: (call: FetchCall, index: number) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test('官方 B：扫码登录取回官方凭证，二维码直接交给 UI', async () => {
  const { fetchImpl, calls } = fakeFetch((_call, index) => {
    if (index === 0) return jsonResponse({ qrcode: 'q1', qrcode_img_content: 'https://qr.example/1' });
    if (index === 1) return jsonResponse({ status: 'wait' });
    return jsonResponse({
      status: 'confirmed',
      bot_token: 'bot-token',
      ilink_bot_id: 'bot-1',
      baseurl: 'https://api.example',
      ilink_user_id: 'boss-1',
    });
  });
  const client = new OfficialWechatClient({ fetchImpl, qrPollIntervalMs: 1 });
  const qr: string[] = [];
  const statuses: string[] = [];
  const result = await client.login({
    onQRCode: (url) => {
      qr.push(url);
    },
    onStatus: (status) => {
      statuses.push(status);
    },
  });

  assert.deepEqual(result, {
    connected: true,
    botToken: 'bot-token',
    accountId: 'bot-1',
    baseUrl: 'https://api.example',
    userId: 'boss-1',
    message: '已连接微信',
  });
  assert.deepEqual(qr, ['https://qr.example/1']);
  assert.deepEqual(statuses, ['wait', 'confirmed']);
  assert.match(calls[0]!.url, /get_bot_qrcode\?bot_type=3/);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { local_token_list: [] });
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['iLink-App-Id'], 'bot');
  assert.equal(headers.Authorization, undefined, '首次扫码不能带旧 token');
});

test('官方 B：二维码过期后刷新一次，仍能完成登录', async () => {
  const { fetchImpl } = fakeFetch((_call, index) => {
    if (index === 0) return jsonResponse({ qrcode: 'q1', qrcode_img_content: 'https://qr.example/1' });
    if (index === 1) return jsonResponse({ status: 'expired' });
    if (index === 2) return jsonResponse({ qrcode: 'q2', qrcode_img_content: 'https://qr.example/2' });
    return jsonResponse({
      status: 'confirmed',
      bot_token: 'tok',
      ilink_bot_id: 'bot',
      ilink_user_id: 'boss',
    });
  });
  const client = new OfficialWechatClient({ fetchImpl, qrPollIntervalMs: 1 });
  const qr: string[] = [];
  const result = await client.login({
    onQRCode: (url) => {
      qr.push(url);
    },
  });
  assert.equal(result.connected, true);
  assert.deepEqual(qr, ['https://qr.example/1', 'https://qr.example/2']);
});

test('官方 B：手机要求数字验证码时，设置页提交后继续登录', async () => {
  const { fetchImpl } = fakeFetch((_call, index) => {
    if (index === 0) return jsonResponse({ qrcode: 'q1', qrcode_img_content: 'https://qr.example/1' });
    if (index === 1) return jsonResponse({ status: 'need_verifycode' });
    return jsonResponse({
      status: 'confirmed',
      bot_token: 'tok',
      ilink_bot_id: 'bot',
      ilink_user_id: 'boss',
    });
  });
  const client = new OfficialWechatClient({ fetchImpl, qrPollIntervalMs: 1 });
  const result = await client.login({
    onQRCode: () => {},
    onStatus: (status) => {
      if (status === 'need_verifycode') client.submitVerifyCode('123456');
    },
  });
  assert.equal(result.connected, true);
});

test('官方 B：getupdates 保存 sync buf、记录 context_token，并保住 uint64 消息 id', async () => {
  const raw = textResponse(
    '{"ret":0,"get_updates_buf":"buf-2","msgs":[{"message_type":1,"from_user_id":"boss-1","message_id":9007199254740993123,"context_token":"ctx-9","item_list":[{"type":1,"text_item":{"text":"你好"}}]}]}',
  );
  const { fetchImpl, calls } = fakeFetch((_call, index) => {
    if (index === 0) return raw;
    return new Promise<Response>((_resolve, reject) => {
      const signal = calls[index]!.init.signal;
      signal?.addEventListener(
        'abort',
        () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  });
  const client = new OfficialWechatClient({
    token: 'bot-token',
    baseUrl: 'https://api.example',
    fetchImpl,
  });
  const messages: Array<{ message_id?: string | number }> = [];
  const saved: string[] = [];
  client.on('message', ((message: { message_id?: string | number }) => {
    messages.push(message);
    client.stop();
  }) as (...args: never[]) => void);

  await client.start({
    longPollTimeoutMs: 5_000,
    loadSyncBuf: () => 'buf-1',
    saveSyncBuf: (buf) => {
      saved.push(buf);
    },
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.message_id, '9007199254740993123');
  assert.deepEqual(saved, ['buf-2']);
  assert.equal(client.getContextToken('boss-1'), 'ctx-9');
  const first = calls[0]!;
  assert.match(first.url, /getupdates$/);
  const body = JSON.parse(String(first.init.body)) as {
    get_updates_buf: string;
    base_info: { channel_version: string };
  };
  assert.equal(body.get_updates_buf, 'buf-1');
  assert.equal(body.base_info.channel_version, '2.4.10');
  const headers = first.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer bot-token');
});

test('官方 B：发文本带 context_token，返回服务器消息 id', async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    textResponse('{"ret":0,"message_id":9007199254740993999}'),
  );
  const client = new OfficialWechatClient({
    token: 'bot-token',
    baseUrl: 'https://api.example',
    fetchImpl,
  });
  const messageId = await client.sendText('boss-1', '收到', 'ctx-1');

  assert.equal(messageId, '9007199254740993999');
  const body = JSON.parse(String(calls[0]!.init.body)) as {
    msg: {
      to_user_id: string;
      message_type: number;
      item_list: Array<{ text_item: { text: string } }>;
      context_token: string;
    };
  };
  assert.equal(body.msg.to_user_id, 'boss-1');
  assert.equal(body.msg.message_type, 2);
  assert.equal(body.msg.context_token, 'ctx-1');
  assert.equal(body.msg.item_list[0]!.text_item.text, '收到');
});

test('官方 B：getupdates -14 → sessionExpired，不当作普通错误重连', async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse({ ret: -14, errmsg: 'session timeout' }));
  const client = new OfficialWechatClient({
    token: 'stale',
    baseUrl: 'https://api.example',
    fetchImpl,
  });
  let expired = 0;
  client.on('sessionExpired', (() => {
    expired += 1;
  }) as (...args: never[]) => void);

  await client.start({ loadSyncBuf: () => '' });
  assert.equal(expired, 1);
});

test('官方 B：stop 中止长轮询，start 正常返回', async () => {
  const { fetchImpl } = fakeFetch((call) => {
    return new Promise<Response>((_resolve, reject) => {
      call.init.signal?.addEventListener(
        'abort',
        () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  });
  const client = new OfficialWechatClient({
    token: 'bot-token',
    baseUrl: 'https://api.example',
    fetchImpl,
  });
  const running = client.start({ loadSyncBuf: () => '' });
  await new Promise((resolve) => setImmediate(resolve));
  client.stop();
  await running;
});
