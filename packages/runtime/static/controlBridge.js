"use strict";
(() => {
  // output/desktop-plugin-delivery/public-checkouts/dsh-studio-library/packages/sdk/controlBridge.ts
  (() => {
    if (window.parent === window || window.__dshStudioControl) return;
    window.__dshStudioControl = true;
    const requestType = "dsh:studio:control";
    const resultType = "dsh:studio:controlResult";
    const controls = /* @__PURE__ */ new Map();
    const seen = /* @__PURE__ */ new Set();
    const cancelled = /* @__PURE__ */ new Set();
    const allowedParents = /* @__PURE__ */ new Set([location.origin, "dsh-app://app"]);
    const isLocal = (url) => ["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    try {
      const parent = new URL(document.referrer);
      if (isLocal(parent) && parent.port === "5173") allowedParents.add(parent.origin);
    } catch {
    }
    const redact = (value) => value.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[\u51ED\u636E\u5DF2\u9690\u85CF]").replace(/\b(?:sk-[\w-]+|[a-f0-9]{24,})\b/gi, "[\u51ED\u636E\u5DF2\u9690\u85CF]").slice(0, 12e3);
    const visible = (node) => {
      if (node.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
      if (getComputedStyle(node).pointerEvents === "none") return false;
      for (let item = node; item; item = item.parentElement) {
        const style = getComputedStyle(item);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return node.getClientRects().length > 0;
    };
    const label = (node) => {
      const labelled = node.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      const field = node;
      return (node.getAttribute("aria-label") || labelled || field.labels?.[0]?.textContent || node.getAttribute("placeholder") || node.getAttribute("title") || node.innerText || node.textContent || field.name || "").trim().replace(/\s+/g, " ").slice(0, 180);
    };
    const sensitive = (node) => node.matches('input[type="password"],input[type="file"]') || /密码|密钥|令牌|secret|token|api.?key|password/i.test(label(node) + " " + node.name + " " + node.id);
    let generation = 0;
    const pageId = crypto.randomUUID().slice(0, 8);
    function snapshot(offset = 0) {
      controls.clear();
      generation += 1;
      const nodes = [...document.querySelectorAll('button,a[href],input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="tab"],[role="checkbox"],[contenteditable="true"],[tabindex]')].filter(visible);
      const entries = nodes.slice(offset, offset + 100).map((node, index) => {
        const id = pageId + "-c" + generation + "-" + (offset + index);
        controls.set(id, node);
        const input = node;
        const secret = sensitive(node);
        return {
          id,
          tag: node.tagName.toLowerCase(),
          label: redact(label(node)),
          type: input.type || node.getAttribute("role") || void 0,
          disabled: node.matches(':disabled,[aria-disabled="true"]'),
          sensitive: secret || void 0,
          value: !secret && node.matches("input,textarea,select") ? redact(input.value) : void 0,
          checked: node.matches('input[type="checkbox"],input[type="radio"]') ? input.checked : void 0,
          selected: node.getAttribute("aria-pressed") ?? node.getAttribute("aria-selected") ?? (node.classList.contains("is-active") ? "true" : void 0),
          options: node instanceof HTMLSelectElement ? [...node.options].slice(0, 80).map((option) => ({ value: option.value, label: redact(option.text), disabled: option.disabled })) : void 0
        };
      });
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const text = [];
      let length = 0;
      while (walker.nextNode() && length < 12e3) {
        const parent = walker.currentNode.parentElement;
        if (!parent || parent.closest("script,style,noscript,input,textarea,[data-sensitive]") || !visible(parent)) continue;
        const value = walker.currentNode.textContent?.trim();
        if (value) {
          text.push(value);
          length += value.length;
        }
      }
      const result = { title: document.title, path: location.pathname, text: redact(text.join("\n")), controls: entries, totalControls: nodes.length, nextOffset: offset + entries.length < nodes.length ? offset + entries.length : null };
      while (JSON.stringify(result).length > 48e3 && entries.length > 1) entries.pop();
      result.nextOffset = offset + entries.length < nodes.length ? offset + entries.length : null;
      return result;
    }
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function perform(command) {
      if (command.action === "open" || command.action === "read") return snapshot(command.offset ?? 0);
      const node = command.target ? controls.get(command.target) : void 0;
      if (command.target && (!node?.isConnected || !visible(node))) throw new Error("\u9875\u9762\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0 read \u83B7\u53D6\u63A7\u4EF6");
      if (node?.matches(':disabled,[aria-disabled="true"]')) throw new Error("\u63A7\u4EF6\u5F53\u524D\u4E0D\u53EF\u7528");
      if (node && sensitive(node)) throw new Error("\u654F\u611F\u8BBE\u7F6E\u8BF7\u7531\u7528\u6237\u5728\u9875\u9762\u4E2D\u64CD\u4F5C");
      if (command.action === "scroll") {
        const horizontal = ["left", "right"].includes(command.direction);
        let container = node ?? document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        while (container && !(horizontal ? container.scrollWidth > container.clientWidth : container.scrollHeight > container.clientHeight)) container = container.parentElement;
        container ??= document.scrollingElement;
        const amount = ["up", "left"].includes(command.direction) ? -480 : 480;
        container.scrollBy({ [horizontal ? "left" : "top"]: amount, behavior: "instant" });
      } else {
        if (!node) throw new Error("\u8BF7\u63D0\u4F9B\u6700\u8FD1 read \u8FD4\u56DE\u7684\u63A7\u4EF6 id");
        node.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        node.focus({ preventScroll: true });
        if (command.action === "click") {
          if (node instanceof HTMLAnchorElement && !["http:", "https:", "dsh-app:"].includes(new URL(node.href).protocol)) throw new Error("\u4E0D\u652F\u6301\u6B64\u94FE\u63A5\u7C7B\u578B");
          node.click();
        } else if (command.action === "fill") {
          if (typeof command.value !== "string" || command.value.length > 8e3) throw new Error("\u8F93\u5165\u5185\u5BB9\u65E0\u6548");
          if (node.matches('input:not([type="checkbox"]):not([type="radio"]),textarea') && !node.readOnly) {
            const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, command.value);
            node.dispatchEvent(new Event("input", { bubbles: true }));
            node.dispatchEvent(new Event("change", { bubbles: true }));
          } else if (node.isContentEditable) {
            node.textContent = command.value;
            node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: command.value }));
          } else throw new Error("\u8BE5\u63A7\u4EF6\u4E0D\u80FD\u586B\u5199\uFF0C\u8BF7\u4F7F\u7528 click \u6216 select");
        } else if (command.action === "select" && node instanceof HTMLSelectElement) {
          if (![...node.options].some((option) => option.value === command.value && !option.disabled)) throw new Error("\u9009\u9879\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u7528");
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(node, command.value);
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
        } else throw new Error("\u4E0D\u652F\u6301\u6B64\u63A7\u4EF6\u64CD\u4F5C");
      }
      await delay(250);
      return snapshot();
    }
    let busy = false;
    window.addEventListener("message", async (event) => {
      const data = event.data;
      if (event.source !== window.parent || !allowedParents.has(event.origin) || ![requestType, "dsh:studio:controlCancel"].includes(data?.type) || typeof data.id !== "string" || !/^[a-f0-9-]{36}$/.test(data.id)) return;
      if (data.type === "dsh:studio:controlCancel") {
        if (cancelled.size >= 128) cancelled.delete(cancelled.values().next().value);
        cancelled.add(data.id);
        const frame = document.querySelector("iframe[data-studio-app]");
        if (frame && isLocal(new URL(frame.src))) frame.contentWindow?.postMessage(data, new URL(frame.src).origin);
        return;
      }
      const reply = (body) => window.parent.postMessage({ type: resultType, id: data.id, ...body }, event.origin);
      if (data.action === "ping") {
        reply({ ready: true });
        return;
      }
      if (seen.has(data.id)) {
        reply({ error: "\u64CD\u4F5C\u5DF2\u63A5\u6536\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u9875\u9762\uFF0C\u4E0D\u8981\u91CD\u590D\u63D0\u4EA4" });
        return;
      }
      if (busy) {
        reply({ error: "\u9875\u9762\u6B63\u5728\u6267\u884C\u53E6\u4E00\u4E2A\u64CD\u4F5C" });
        return;
      }
      if (cancelled.has(data.id) || !Number.isFinite(data.expiresAt) || data.expiresAt < Date.now()) {
        reply({ error: "\u64CD\u4F5C\u5DF2\u53D6\u6D88\u6216\u8FC7\u671F" });
        return;
      }
      if (seen.size >= 128) seen.delete(seen.values().next().value);
      seen.add(data.id);
      busy = true;
      try {
        const deadline = Math.min(data.expiresAt - 1e3, Date.now() + 1e4);
        const loading = () => document.readyState === "loading" || document.querySelector('[data-studio-loading="true"]') || [...document.querySelectorAll("#root,#app")].some((root) => !root.children.length);
        while (loading() && Date.now() < deadline && !cancelled.has(data.id)) await delay(100);
        if (cancelled.has(data.id) || data.expiresAt < Date.now()) throw new Error("\u64CD\u4F5C\u5DF2\u53D6\u6D88\u6216\u8FC7\u671F");
        if (loading()) throw new Error("\u9875\u9762\u4ECD\u5728\u52A0\u8F7D\uFF0C\u8BF7\u7A0D\u540E\u91CD\u65B0 read");
        const child = document.querySelector("iframe[data-studio-app]");
        if (child) {
          const origin = new URL(child.src, location.href).origin;
          if (!isLocal(new URL(origin))) throw new Error("\u5DE5\u4F5C\u5BA4\u63A7\u5236\u4EC5\u652F\u6301\u672C\u673A\u5E94\u7528");
          const forwarded = await new Promise((resolve, reject) => {
            let sent = false;
            const finish = (error, result) => {
              clearInterval(probe);
              clearTimeout(timer);
              window.removeEventListener("message", receive);
              error ? reject(error) : resolve(result);
            };
            const receive = (message) => {
              if (message.source !== child.contentWindow || message.origin !== origin || message.data?.type !== resultType || message.data.id !== data.id) return;
              if (message.data.ready && !sent) {
                if (cancelled.has(data.id) || data.expiresAt < Date.now()) {
                  finish(new Error("\u64CD\u4F5C\u5DF2\u53D6\u6D88\u6216\u8FC7\u671F"));
                  return;
                }
                sent = true;
                clearInterval(probe);
                child.contentWindow?.postMessage(data, origin);
              } else if (sent && !message.data.ready) finish(void 0, message.data);
            };
            window.addEventListener("message", receive);
            const ping = () => child.contentWindow?.postMessage({ ...data, action: "ping" }, origin);
            const probe = setInterval(ping, 150);
            const timer = setTimeout(() => finish(new Error(sent ? "\u5E94\u7528\u54CD\u5E94\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u9875\u9762\u786E\u8BA4\u7ED3\u679C" : "\u5E94\u7528\u5C1A\u672A\u5C31\u7EEA\u6216\u672A\u5B89\u88C5\u63A7\u5236\u6865")), Math.max(1, Math.min(18e3, data.expiresAt - Date.now())));
            ping();
          });
          window.parent.postMessage(forwarded, event.origin);
        } else reply({ result: await perform(data) });
      } catch (error) {
        reply({ error: error instanceof Error ? error.message : "\u5DE5\u4F5C\u5BA4\u64CD\u4F5C\u5931\u8D25" });
      } finally {
        busy = false;
      }
    });
  })();
})();
