// 导图页面的 HTML 骨架。插件和预览工具共用，免得两边不一致。
// 工具栏一行四组：卡片（只看标题 | 显示规则）、隐藏已完成、缩放（− 百分比 +，点百分比适应窗口）、跟随 AI；⋯ 里是不常用的。
// 文字由 map.js 按语言填：data-t 是文字，data-t-short 是窄的时候用的短文字，data-t-title / data-t-aria 是提示和读屏名字
const ICO = d => `<svg class="ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
module.exports = `<div class="toolbar">
  <span class="title" data-t="m.title"></span>
  <span id="summary" class="summary"></span>
  <div class="tseg" role="group" data-t-aria="m.cards">
    <button data-act="compactAll" aria-pressed="true" data-t="m.titles" data-t-short="m.titles.short" data-t-title="m.titlesTip"></button><button data-act="rulesAll" aria-pressed="false" data-t="m.rules" data-t-short="m.rules.short" data-t-title="m.rulesTip"></button>
  </div>
  <button class="ttog" data-act="hideDone" aria-pressed="false" data-t="m.hideDone" data-t-short="m.hideDone.short" data-t-title="m.hideDoneTip"></button>
  <div class="tzoom" role="group" data-t-aria="m.zoom">
    <button data-act="zoomOut" data-t-aria="m.zoomOut" data-t-title="m.zoomOut">${ICO('M5 12h14')}</button><button class="zpct" data-act="fit" data-t-title="m.fit">100%</button><button data-act="zoomIn" data-t-aria="m.zoomIn" data-t-title="m.zoomIn">${ICO('M12 5v14M5 12h14')}</button>
  </div>
  <button class="follow" data-act="follow" aria-pressed="true" data-t-title="m.followTip"><span class="fdot" aria-hidden="true"></span><span data-t="follow" data-t-short="follow.short"></span></button>
  <button class="ibtn tmore" data-act="mapMore" data-t-title="m.more" data-t-aria="m.more" aria-haspopup="menu"><svg class="ico ico-more" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/></svg></button>
</div>
<div id="focusbar" class="focusbar" role="navigation" data-t-aria="m.focusPath" hidden></div>
<div id="alerts"></div>
<div class="main">
  <svg id="canvas" role="img" data-t-aria="m.title"><g id="world"></g></svg>
  <aside id="side" class="dp"></aside>
</div>`;
