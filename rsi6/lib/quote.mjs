// 通用 HTTP GET：腾讯 gtimg 返回 GBK，新浪返回 UTF-8，按 URL 自动选择解码。
import https from 'node:https';

export function httpGet(url, extraHeaders = {}, retries = 1) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://gu.qq.com/" }, extraHeaders);
    const attempt = (n) => {
      const req = https.get(url, { headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode >= 300) { reject(new Error("HTTP " + res.statusCode)); return; }
          const buf = Buffer.concat(chunks);
          const isGbk = url.includes("qt.gtimg.cn") || url.includes("hq.sinajs.cn");
          const text = isGbk ? new TextDecoder("gbk").decode(buf) : new TextDecoder("utf-8").decode(buf);
          resolve(text);
        });
      });
      req.on("error", (e) => { if (n > 0) attempt(n - 1); else reject(e); });
      req.setTimeout(7000, () => { req.destroy(); if (n > 0) attempt(n - 1); else reject(new Error("timeout")); });
      req.end();
    };
    attempt(retries);
  });
}
