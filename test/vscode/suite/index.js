'use strict';
// 扩展宿主里加载的测试入口（--extensionTestsPath）。mocha 装在临时目录，路径由 run.js 传进来
const path = require('path');

// 记下扩展宿主里的 console.error（插件出错时多半走这里）。panel 套件里插件在这之后才激活，能完整收集
global.__rtErrors = [];
const origError = console.error;
console.error = (...args) => { global.__rtErrors.push(args.map(a => (a && a.stack) || String(a)).join(' ')); origError.apply(console, args); };

exports.run = function run() {
  const Mocha = require(process.env.RT_MOCHA);
  const mocha = new Mocha({ ui: 'bdd', timeout: 30000, color: false, reporter: 'spec' });
  mocha.addFile(path.join(__dirname, `${process.env.RT_SUITE}.it.js`));
  return new Promise((resolve, reject) => {
    mocha.run(failures => (failures ? reject(new Error(`${failures} 项失败`)) : resolve()));
  });
};
