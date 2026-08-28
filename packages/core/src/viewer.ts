/**
 * A small self-contained panel embedded in single-file output so whoever
 * reopens the capture can browse the data-capture blocks (metadata, tokens,
 * logs, raw sources) instead of hunting for them in view-source. No
 * dependencies, no network access, nothing that touches the captured page's
 * own DOM or scripts — it only reads the `script[data-capture]` blocks
 * QuickCaps itself appended.
 */

const NAMES: Record<string, string> = {
  screenshot: 'Screenshot',
  metadata: 'Metadata',
  tokens: 'Design tokens',
  logs: 'Console + network log',
  perf: 'Performance snapshot',
  raw: 'Raw sources',
};

// The extension icon, inlined so the panel still shows the QuickCaps mark in
// a standalone exported file with no extension runtime to fetch it from.
const LOGO_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAEiElEQVR42r2Xf0zUdRjHP/9os2WeOZ26HA6X6WKCskyXmWiECNNU5IeK0mwOWynkXF5Cu5zLNEARISWF8UMPGOiJlohgHAgRFxK4c+IJV8SNyuHRQtjh7F3P937I9/v9fLlva/Bsz1+Mez2f5/P+ft7Pw5groosdmugihy5KP2jddG4AEQX92JD3F9bn/ol1OX1Ye+YhwrN7EXbqAUKz/sDqk78hJKMHwek2vHWsGytTuxD05S9484gVyw93Ytnn9/H6IQuWHmzHEt1dLP70Dl5NMlsDP7mtW6Rt07DhEVMyFBBd7LBH6QcxinAEHriNRdo2BHz8k91/X0vA05OPLRz++1qwYG+z3S/RpGGuto81HH6JJryS0KRjo3znyvA9TZi/u9HKlOC7y/rQZhsSstXmQGu3Axda+r3Cixofotn6SMgfO/uFjDrezoNj3gffg40E50Xk4TpFeOwpK/d/Gtp+xabUOzL43PfrwXhtd8MbWn9GWoERqfmUNUg4asDczTkjtj35XDuO5lQLeeRsFW7e6hR+q761Cy/vqhHBX4q/Cca7c3cBBA9MqMTSJBOWHGjCa9pGVXfu96ER8+MrMW/nNWSU3xd+q665A3Pirojgc3bWgvEER3dOQScn+P8RXFaFzVOA7/bLIrjve0YwntpJcM4CaoSTS+FxX3eh+Ae7R2z6hl5sPmnhqj3z6tMCZsdeEsFn7/gOjPepkdop6M6lbScwL3r6AN2FBzK1aws7hL9n6evgs9Uggvu8ewNM6TsntUsFpwR//ASovQfcuAskF3XL1B6qrcK04DT47qgWwWdtrwJT+8hQ25Xi3u9OuDuXf1QpU7v05AR/MfY6mNoXTun0g0NiOOXeTHXwmVuugal9XklsvLjVJS8gw8AXnBQ+I6YCTO3bHp/Xi/2lj2RZ1vxEVsAJQwdmrjvjFT49+lswtcay5asebgGflQ/ICkhMr8WsqBKv8GmR34CpfWRWHGrnFkCZW/9YVID/xjT4bLvqFT414jLYSMYifeFiMm3cApIuDqDS/Lfn9FPfThfBQ5IaufApG8rBlCyVgoxF+rxGHu/kFnGi2iHAJ79xED5x1z3wxGyz8Funr1hk8BfeMYDx2u5WPDkaGYv0eV24qwLhyXXYdsws5Jr91fANSxFOPhxObU8tc5pRrcmCKeEFIrhm7UUw3p0PL4BcTWmYoE+N1E6CU7rzlFJnAUaTBZPX5Ivgk8LLwHiCoymGgvycLJUHV/PI0J2nlFo8BWhC80TwiWGlYDxLdRdAwwT5OVkquRoZizc43Tm1nU5O8Hpzr7OAJgsmheSK4M+FloDx/JxmOBqjeEHGogQntfOC4IsjvsDzq/NF8GdDisGUhgma4WiMIh93J1kqudpIbSe1k+CM7nTBJ67KlsEnBOvBhHVJYXSmGY7GKJpkSHDk5zxLlT4ypHYSHN05tZ13coI/s+q8lbl2NaW5/T8JjvedS+98GBzjVxbqGC2Krl1tbOFBhfbxQYXOJZUWRdeuNmbwcSsKAkQbMi2KtKvRujSKcCu13XPyf+MfJwqDHTa2bFwAAAAASUVORK5CYII=';

export function viewerPanelBlock(): string {
  const style = `
#quickcaps-viewer{position:fixed;inset:0 auto 0 100%;z-index:2147483647;font:12.5px/1.5 ui-monospace,'SF Mono',Menlo,Consolas,monospace;color:#e6e6e6;pointer-events:none}
#quickcaps-viewer .qc-fab{position:fixed;right:14px;bottom:14px;pointer-events:auto;display:flex;align-items:center;gap:6px;cursor:pointer;border:none;border-radius:20px;padding:8px 14px;background:#1f1f1f;color:#e6e6e6;font:600 12px/1 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35);transition:transform .15s ease,background-color .15s ease,box-shadow .15s ease}
#quickcaps-viewer .qc-fab:hover{background:#2b2b2b;transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.4)}
#quickcaps-viewer .qc-fab img{width:16px;height:16px;border-radius:4px;display:block}
#quickcaps-viewer .qc-panel{position:fixed;top:0;right:0;bottom:0;width:min(380px,92vw);display:flex;flex-direction:column;background:#161616;border-left:1px solid #2a2a2a;box-shadow:-8px 0 24px rgba(0,0,0,.35);transform:translateX(100%);transition:transform .22s cubic-bezier(.32,.72,0,1);pointer-events:auto}
#quickcaps-viewer .qc-panel.qc-open{transform:translateX(0)}
#quickcaps-viewer .qc-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #262626;font:600 12.5px/1 system-ui,sans-serif}
#quickcaps-viewer .qc-head img{width:18px;height:18px;border-radius:5px;display:block}
#quickcaps-viewer .qc-head .qc-title{flex:1}
#quickcaps-viewer .qc-close{cursor:pointer;border:none;background:transparent;color:#999;font-size:16px;line-height:1;padding:2px 4px;border-radius:4px;transition:color .15s ease,background-color .15s ease}
#quickcaps-viewer .qc-close:hover{color:#e6e6e6;background:#262626}
#quickcaps-viewer .qc-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px;border-bottom:1px solid #222}
#quickcaps-viewer .qc-tabs button{cursor:pointer;border:1px solid transparent;border-radius:999px;padding:4px 10px;background:#232323;color:#b3b3b3;font:500 11px/1.4 system-ui,sans-serif;transition:background-color .15s ease,color .15s ease,border-color .15s ease}
#quickcaps-viewer .qc-tabs button:hover{color:#e6e6e6;background:#2a2a2a}
#quickcaps-viewer .qc-tabs button.qc-active{background:#3730a3;color:#e0e3ff;border-color:#4c46c9}
#quickcaps-viewer .qc-body{flex:1;min-height:0;overflow:auto;padding:12px 14px}
#quickcaps-viewer .qc-body pre{white-space:pre-wrap;word-break:break-word;margin:0;animation:qc-fade .12s ease}
#quickcaps-viewer .qc-key{color:#7dd3fc}
#quickcaps-viewer .qc-string{color:#86efac}
#quickcaps-viewer .qc-number{color:#fbbf24}
#quickcaps-viewer .qc-bool{color:#f472b6}
#quickcaps-viewer .qc-null{color:#f472b6}
@keyframes qc-fade{from{opacity:0}to{opacity:1}}
`.trim();

  const script = `
(function(){
  var blocks = Array.prototype.slice.call(
    document.querySelectorAll('script[data-capture],img[data-capture]')
  );
  if (!blocks.length) return;

  var root = document.createElement('div');
  root.id = 'quickcaps-viewer';
  root.setAttribute('data-quickcaps-viewer', '');

  var panel = document.createElement('div');
  panel.className = 'qc-panel';

  var head = document.createElement('div');
  head.className = 'qc-head';
  var headLogo = document.createElement('img');
  headLogo.src = '${LOGO_DATA_URI}';
  headLogo.alt = '';
  var title = document.createElement('span');
  title.className = 'qc-title';
  title.textContent = 'QuickCaps data';
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'qc-close';
  close.textContent = '\\u00d7';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', function () { setOpen(false); });
  head.appendChild(headLogo);
  head.appendChild(title);
  head.appendChild(close);

  var tabs = document.createElement('div');
  tabs.className = 'qc-tabs';
  var bodyWrap = document.createElement('div');
  bodyWrap.className = 'qc-body';
  var body = document.createElement('pre');
  bodyWrap.appendChild(body);

  panel.appendChild(head);
  panel.appendChild(tabs);
  panel.appendChild(bodyWrap);

  var fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'qc-fab';
  fab.innerHTML = '<img src="${LOGO_DATA_URI}" alt=""><span>QuickCaps data</span>';

  function setOpen(open) {
    panel.classList.toggle('qc-open', open);
  }
  fab.addEventListener('click', function () {
    setOpen(!panel.classList.contains('qc-open'));
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') setOpen(false);
  });

  var names = ${JSON.stringify(NAMES)};

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Classic regex JSON colorizer: escape first, then wrap tokens in spans.
  // Runs only on our own JSON.stringify output, so it never sees markup.
  function highlight(json) {
    var escaped = escapeHtml(json);
    return escaped.replace(
      /("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g,
      function (match) {
        var cls = 'qc-number';
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'qc-key' : 'qc-string';
        } else if (/true|false/.test(match)) {
          cls = 'qc-bool';
        } else if (/null/.test(match)) {
          cls = 'qc-null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
      }
    );
  }

  function show(name, tabButton) {
    Array.prototype.forEach.call(tabs.children, function (child) {
      child.classList.remove('qc-active');
    });
    tabButton.classList.add('qc-active');
    var block = blocks.filter(function (b) {
      return b.getAttribute('data-capture') === name;
    })[0];
    // The screenshot rides along as a hidden <img>, not as JSON — show the
    // picture rather than its data url.
    if (block.tagName === 'IMG') {
      body.textContent = '';
      var shot = document.createElement('img');
      shot.src = block.getAttribute('src');
      shot.alt = block.getAttribute('alt') || '';
      shot.style.cssText = 'display:block;width:100%;height:auto;border-radius:4px';
      body.appendChild(shot);
      return;
    }
    try {
      var pretty = JSON.stringify(JSON.parse(block.textContent), null, 2);
      body.innerHTML = highlight(pretty);
    } catch (e) {
      body.textContent = block.textContent;
    }
  }

  blocks.forEach(function (block, index) {
    var name = block.getAttribute('data-capture');
    var tabButton = document.createElement('button');
    tabButton.type = 'button';
    tabButton.textContent = names[name] || name;
    tabButton.addEventListener('click', function () {
      show(name, tabButton);
    });
    tabs.appendChild(tabButton);
    if (index === 0) show(name, tabButton);
  });

  root.appendChild(panel);
  root.appendChild(fab);
  document.body.appendChild(root);
})();
`.trim();

  return `\n<style>${style}</style>\n<script data-quickcaps-viewer>${script}</script>`;
}
