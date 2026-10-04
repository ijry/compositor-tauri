/**
 * 撤销/重做历史
 * ---------------------------------------------------------------
 * 采用「快照 + 闭包」混合策略：像素类操作在闭包里保存前后两份缓冲，
 * 属性类操作只保存旧值。历史栈有内存预算，超出后从最早的记录开始淘汰。
 */
export interface HistoryEntry {
  label: string;
  undo: () => void;
  redo: () => void;
  /** 估算占用字节 */
  bytes: number;
  /** 该记录之后被清空（用于「新操作截断 redo 分支」） */
  mergeKey?: string;
}

export class History {
  private entries: HistoryEntry[] = [];
  private index = -1;
  private bytes = 0;
  private budget: number;
  private listeners = new Set<() => void>();

  constructor(budget = 512 * 1024 * 1024) {
    this.budget = budget;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** 当前栈中的记录（只读视图） */
  list(): readonly HistoryEntry[] {
    return this.entries;
  }

  get position(): number {
    return this.index;
  }

  get canUndo(): boolean {
    return this.index >= 0;
  }

  get canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }

  get usedBytes(): number {
    return this.bytes;
  }

  get totalBudget(): number {
    return this.budget;
  }

  /** 推入一条记录；可传入 mergeKey 与栈顶相同则合并（用于连续滑动参数） */
  push(entry: HistoryEntry): void {
    if (this.index < this.entries.length - 1) {
      // 有 redo 分支时先丢弃
      const removed = this.entries.splice(this.index + 1);
      for (const item of removed) this.bytes -= item.bytes;
    }
    const top = this.entries[this.entries.length - 1];
    if (entry.mergeKey && top && top.mergeKey === entry.mergeKey) {
      // 合并：保留栈顶的 undo，替换其 redo
      top.redo = entry.redo;
      this.bytes -= top.bytes;
      top.bytes = entry.bytes;
      this.bytes += entry.bytes;
      this.index = this.entries.length - 1;
      this.evict();
      this.notify();
      return;
    }
    this.entries.push(entry);
    this.bytes += entry.bytes;
    this.index = this.entries.length - 1;
    this.evict();
    this.notify();
  }

  /** 超出预算时淘汰最早记录（永不淘汰当前可撤销的那条） */
  private evict(): void {
    while (this.bytes > this.budget && this.entries.length > 1) {
      const oldest = this.entries.shift();
      if (!oldest) break;
      this.bytes -= oldest.bytes;
      this.index -= 1;
    }
    if (this.bytes < 0) this.bytes = 0;
  }

  undo(): string | null {
    if (!this.canUndo) return null;
    const entry = this.entries[this.index];
    entry.undo();
    this.index -= 1;
    this.notify();
    return entry.label;
  }

  redo(): string | null {
    if (!this.canRedo) return null;
    this.index += 1;
    const entry = this.entries[this.index];
    entry.redo();
    this.notify();
    return entry.label;
  }

  /** 清空历史（打开工程、重载、外部写入后调用） */
  clear(): void {
    this.entries = [];
    this.index = -1;
    this.bytes = 0;
    this.notify();
  }

  /** 调整内存预算（按设备内存设定） */
  setBudget(bytes: number): void {
    this.budget = bytes;
    this.evict();
  }
}

/** 依据设备可用内存推荐历史预算（默认 512MB，下限 128MB） */
export function recommendedBudget(): number {
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  if (!memory) return 512 * 1024 * 1024;
  if (memory <= 2) return 128 * 1024 * 1024;
  if (memory <= 4) return 256 * 1024 * 1024;
  if (memory <= 8) return 512 * 1024 * 1024;
  return 1024 * 1024 * 1024;
}
