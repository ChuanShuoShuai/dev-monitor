'use strict';

/**
 * 工程适配器工厂。
 *
 * 一个工程 = 一个 Monitor 实例，对外统一这三件事：
 *   prime() / poll()            采集
 *   snapshot() / brief()        给前端的全量 / 摘要
 *   startBuild() / stopBuild()  编译控制（Node 类工程另有 startRun/stopRun）
 *
 * 新增一门技术栈时只要写一个 adapter 并在这里登记，服务端与前端都不用改。
 */

const { UeProjectMonitor } = require('./ue');
const { NodeProjectMonitor } = require('./node');

/** 当前已支持的技术栈（官网「支持环境」与连接指引页都按这个说） */
const SUPPORTED_KINDS = [
  { kind: 'ue', label: 'Unreal Engine 5', adapter: 'ue' },
  { kind: 'node', label: 'Node / 前端构建（Babel · Vite · Next · Webpack）', adapter: 'node' }
];

function createMonitor(proj, cfg, emitFor) {
  const emit = (type, data) => emitFor(proj.id, type, data);
  if (proj.kind === 'ue') return new UeProjectMonitor(proj, cfg.limits, cfg.match, emit);
  // node / generic / 其它命令行型技术栈都走同一个适配器：
  // 有 buildCmd 就能编译，有 runCmd 就能看运行日志，不需要为每一门语言重写一遍
  if (proj.kind !== 'node' && proj.kind !== 'generic') {
    console.warn('  ⚠ 工程「' + proj.name + '」的 kind=' + proj.kind + ' 还没有专用适配器，按命令行工程处理');
  }
  return new NodeProjectMonitor(proj, cfg.limits, cfg.match, emit);
}

module.exports = { createMonitor, SUPPORTED_KINDS };
