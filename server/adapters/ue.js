'use strict';

/**
 * UE 工程适配器 —— 原有行为，一行逻辑都没改，只是包进统一接口。
 *
 * 数据来源：
 *   编译 → build_out.log（build_game.bat 双写的文件，尾随它）+ BuildLogs/ 归档
 *   运行 → Saved/Logs/<工程名>.log
 *   自检 → .workbuddy/tools/_suite_out.txt
 *   产物 → Saved/*.json · _shot/*.png · Saved/Crashes/*
 */

const path = require('path');
const fs = require('fs');

const {
  BuildCollector, UeLogCollector, SuiteCollector, ArtifactCollector
} = require('../collectors');
const { ProcRunner } = require('../runner');

class UeProjectMonitor {
  constructor(proj, limits, match, emit) {
    this.proj = proj;
    this.id = proj.id;
    this.name = proj.name;
    this.kind = 'ue';
    this.ue = proj.ue;
    this.emit = emit;                      // (type, data) —— 已由装配层绑定工程
    this.allowRun = false;

    this.buildC = new BuildCollector(this.ue, limits, emit);
    this.logC = new UeLogCollector(this.ue, limits, emit);
    this.suiteC = new SuiteCollector(this.ue, emit);
    this.artC = new ArtifactCollector(this.ue, limits, emit);

    this.buildRunner = new ProcRunner({
      label: '编译',
      mode: 'bat',
      command: this.ue.buildBat,
      cwd: path.dirname(this.ue.buildBat || '.'),
      maxLines: 200
    });
  }

  prime() {
    this.buildC.prime();
    this.logC.prime();
    this.suiteC.prime();
  }

  poll() {
    this.buildC.tail.poll();
    this.logC.tail.poll();
    this.buildC.scanArchives();
    this.suiteC.poll();
    this.artC.scan();
    /* 进程已退出但日志里始终没有 Result 行（被手动停止 / 脚本秒退）⇒ 收尾，
       否则「编译中」会永远挂着。放在 tail.poll() 之后：退出前写的内容先被读到。 */
    const st = this.buildRunner.state();
    if (!st.running && st.exit) this.buildC.finishIfRunning(st.exit.code);
  }

  startBuild() {
    if (!this.ue.buildBat || !fs.existsSync(this.ue.buildBat)) {
      return { ok: false, error: '找不到编译脚本：' + (this.ue.buildBat || '（未配置）'), status: 400 };
    }
    const r = this.buildRunner.start();
    /* 进程起得来才清状态 —— 起不来要保留上一轮结果，别把失败记录抹掉 */
    if (r.ok) this.buildC.beginBuild();
    return r;
  }

  stopBuild() { return this.buildRunner.stop(); }

  snapshot() {
    return {
      build: this.buildC.snapshot(),
      buildRunner: this.buildRunner.state(),
      ueLog: this.logC.snapshot(),
      suite: this.suiteC.snapshot(),
      artifacts: this.artC.snapshot(),
      run: { canRun: false, running: false, label: '' }
    };
  }

  /** 前端要用的工程描述（不含路径细节以外的东西，够渲染就行） */
  describe(match, allowBuild) {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      kindLabel: this.proj.kindLabel,
      projectRoot: this.ue.projectRoot,
      projectName: this.ue.projectName,
      workspaceRoot: this.ue.workspaceRoot,
      buildOutLog: this.ue.buildOutLog,
      buildBat: this.ue.buildBat,
      allowBuild: allowBuild !== false && this.proj.canBuild,
      storyCategories: match.storyCategories,
      streamCategoryPrefix: match.streamCategoryPrefix,
      pathsPresent: this.proj.pathsPresent,
      canRun: false,
      runCmd: '',
      buildCmd: 'build_game.bat',
      storyFilters: true,
      /* 有自检套件的数据来源（run_selfcheck 产出的脚本结果）⇒ 前端才显示「自检」标签 */
      hasSuite: true
    };
  }

  /** 「完整日志」按钮直接用现有 build_out.log */
  latestBuildLog() { return this.ue.buildOutLog; }

  /** 图片白名单（防路径穿越） */
  imageRoots() {
    return [this.ue.shotDir, this.ue.crashesDir, path.join(this.ue.savedDir, 'Autoscreenshot.png')];
  }

  /** 文本白名单：报告 / 崩溃日志 / 编译日志 */
  textRoots() {
    return [
      this.ue.savedDir, this.ue.crashesDir, this.ue.shotDir,
      this.ue.buildLogsDir, this.ue.buildOutLog, this.ue.buildErrorsLog
    ];
  }

  brief() {
    const b = this.buildC.snapshot();
    return {
      id: this.id, name: this.name, kind: this.kind, kindLabel: this.proj.kindLabel,
      status: b.status, result: b.result,
      running: this.buildRunner.running || b.status === 'running',
      runRunning: false, canRun: false, canBuild: this.proj.canBuild
    };
  }
}

module.exports = { UeProjectMonitor };
