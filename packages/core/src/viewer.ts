/**
 * A small self-contained panel embedded in single-file output so whoever
 * reopens the capture can browse the data-capture blocks (metadata, tokens,
 * logs, raw sources) instead of hunting for them in view-source. No
 * dependencies, no network access, nothing that touches the captured page's
 * own DOM or scripts — it only reads the `script[data-capture]` blocks
 * QuickCaps itself appended.
 */

const NAMES: Record<string, string> = {
  metadata: 'Metadata',
  tokens: 'Design tokens',
  logs: 'Console + network log',
  perf: 'Performance snapshot',
  raw: 'Raw sources',
};

export function viewerPanelBlock(): string {
  const style = `
#quickcaps-viewer{position:fixed;right:12px;bottom:12px;z-index:2147483647;font:12px/1.4 system-ui,sans-serif;color:#e6e6e6}
#quickcaps-viewer button{cursor:pointer;border:none;border-radius:6px;padding:6px 10px;background:#1f1f1f;color:#e6e6e6;font:inherit}
#quickcaps-viewer .qc-panel{display:none;margin-bottom:6px;width:320px;max-height:360px;overflow:auto;background:#1f1f1f;border-radius:8px;padding:8px}
#quickcaps-viewer .qc-panel.qc-open{display:block}
#quickcaps-viewer .qc-tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}
#quickcaps-viewer .qc-tabs button{padding:4px 8px;background:#333}
#quickcaps-viewer .qc-tabs button.qc-active{background:#555}
#quickcaps-viewer pre{white-space:pre-wrap;word-break:break-word;margin:0}
`.trim();

  const script = `
(function(){
  var blocks = Array.prototype.slice.call(
    document.querySelectorAll('script[data-capture]')
  );
  if (!blocks.length) return;
  var root = document.createElement('div');
  root.id = 'quickcaps-viewer';
  root.setAttribute('data-quickcaps-viewer', '');
  var panel = document.createElement('div');
  panel.className = 'qc-panel';
  var tabs = document.createElement('div');
  tabs.className = 'qc-tabs';
  var body = document.createElement('pre');
  panel.appendChild(tabs);
  panel.appendChild(body);
  var toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'QuickCaps data';
  toggle.addEventListener('click', function () {
    panel.classList.toggle('qc-open');
  });
  var names = ${JSON.stringify(NAMES)};
  function show(name, tabButton) {
    Array.prototype.forEach.call(tabs.children, function (child) {
      child.classList.remove('qc-active');
    });
    tabButton.classList.add('qc-active');
    var block = blocks.filter(function (b) {
      return b.getAttribute('data-capture') === name;
    })[0];
    try {
      body.textContent = JSON.stringify(JSON.parse(block.textContent), null, 2);
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
  root.appendChild(toggle);
  document.body.appendChild(root);
})();
`.trim();

  return `\n<style>${style}</style>\n<script data-quickcaps-viewer>${script}</script>`;
}
