/**
 * 状态机（栈式）—— 统一生命周期虚函数
 * ------------------------------------------------------------------
 * BaseState 生命周期：onEnter / onExit / onUpdate(dt) / onRender(ctx) /
 *                     onTouchStart / onTouchMove / onTouchEnd
 *
 * 栈式设计：
 *   switchTo(state)  清空栈并进入新状态（大厅 → 局内）
 *   push(state)      在当前状态之上压入新状态（局内死亡 → 压入结算层，
 *                    底下层保留但不更新，渲染由上层自行决定是否透出）
 *   pop()            弹出栈顶（结算复活 → 回到仍在栈中的局内层）
 * 只有栈顶状态接收 update 与触摸事件。
 */
export class BaseState {
  constructor(game) {
    this.game = game;
  }
  getName() { return this.constructor.name; }
  onEnter() {}
  onExit() {}
  /** 从上层状态 pop 回来时恢复（如结算页复活回局内），不触发 onEnter 重置 */
  onResume() {}
  onUpdate(dt) {}
  onRender(ctx) {}
  onTouchStart(touch) {}
  onTouchMove(touch) {}
  onTouchEnd(touch) {}
}

export class StateMachine {
  constructor(game) {
    this.game = game;
    this.stack = [];
  }

  get current() {
    return this.stack[this.stack.length - 1] || null;
  }

  _exitTop() {
    const top = this.current;
    if (top) top.onExit();
  }

  switchTo(state) {
    this._exitTop();
    this.stack = [state];
    state.onEnter();
  }

  push(state) {
    this._exitTop();
    this.stack.push(state);
    state.onEnter();
  }

  pop() {
    this._exitTop();
    this.stack.pop();
    const top = this.current;
    if (top && top.onResume) top.onResume(); // 恢复底下的状态（不重置）
  }

  update(dt) {
    const top = this.current;
    if (top) top.onUpdate(dt);
  }

  render(ctx) {
    // 从底到顶渲染，上层可覆盖；顶层默认需自行绘制或选择透出下层
    for (const s of this.stack) s.onRender(ctx);
  }

  touchStart(touch) { const t = this.current; if (t) t.onTouchStart(touch); }
  touchMove(touch) { const t = this.current; if (t) t.onTouchMove(touch); }
  touchEnd(touch) { const t = this.current; if (t) t.onTouchEnd(touch); }
}
