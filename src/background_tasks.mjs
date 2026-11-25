const PRIORITY = Object.freeze({ high: 0, normal: 1, low: 2 });

export class BackgroundTaskBudget {
  constructor({ maxConcurrent = 1, minGapMs = 150, historyLimit = 40 } = {}) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 1);
    this.minGapMs = Math.max(0, Number(minGapMs) || 0);
    this.historyLimit = Math.max(10, Number(historyLimit) || 40);
    this.queue = [];
    this.running = new Map();
    this.pendingByKey = new Map();
    this.history = [];
    this.sequence = 0;
    this.pumping = false;
  }

  enqueue(name, task, { priority = 'normal', dedupeKey = name } = {}) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('background task must be a function'));
    const key = String(dedupeKey || name);
    const existing = this.pendingByKey.get(key);
    if (existing) return existing.promise;
    let resolveTask, rejectTask;
    const promise = new Promise((resolve, reject) => { resolveTask = resolve; rejectTask = reject; });
    const item = {
      id: ++this.sequence, name:String(name || key), key,
      priority: Object.hasOwn(PRIORITY, priority) ? priority : 'normal',
      queuedAt:Date.now(), startedAt:null, completedAt:null,
      task, promise, resolveTask, rejectTask,
    };
    this.queue.push(item);
    this.pendingByKey.set(key, item);
    this.queue.sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.id - b.id);
    this.#pump();
    return promise;
  }

  getStatus() {
    const slim = item => ({ id:item.id, name:item.name, key:item.key, priority:item.priority,
      queuedAt:item.queuedAt, startedAt:item.startedAt, completedAt:item.completedAt,
      durationMs:item.durationMs ?? null, status:item.status || (item.startedAt ? 'running' : 'queued'), error:item.error || null });
    return {
      maxConcurrent:this.maxConcurrent,
      running:[...this.running.values()].map(slim),
      queued:this.queue.map(slim),
      recent:this.history.slice(-this.historyLimit).reverse().map(slim),
    };
  }

  async #pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running.size < this.maxConcurrent && this.queue.length) {
        const item = this.queue.shift();
        item.startedAt = Date.now();
        item.status = 'running';
        this.running.set(item.key, item);
        Promise.resolve().then(item.task).then(
          value => this.#finish(item, 'complete', null, value),
          error => this.#finish(item, 'failed', error),
        );
      }
    } finally {
      this.pumping = false;
    }
  }

  #finish(item, status, error, value) {
    item.completedAt = Date.now();
    item.durationMs = item.completedAt - item.startedAt;
    item.status = status;
    item.error = error ? String(error.message || error) : null;
    this.running.delete(item.key);
    this.pendingByKey.delete(item.key);
    this.history.push(item);
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    if (error) item.rejectTask(error); else item.resolveTask(value);
    setTimeout(() => this.#pump(), this.minGapMs);
  }
}

export const backgroundTaskBudget = new BackgroundTaskBudget({
  maxConcurrent:Number(process.env.DASHBOARD_BACKGROUND_CONCURRENCY || 1),
  minGapMs:Number(process.env.DASHBOARD_BACKGROUND_GAP_MS || 150),
});

// Market-facing scans must remain responsive even while a large historical
// backfill is running. Maintenance work therefore has its own one-job lane.
export const maintenanceTaskBudget = new BackgroundTaskBudget({
  maxConcurrent:Number(process.env.DASHBOARD_MAINTENANCE_CONCURRENCY || 1),
  minGapMs:Number(process.env.DASHBOARD_MAINTENANCE_GAP_MS || 300),
});

// Slow, non-interactive enrichment must not delay backups or their integrity
// checks. It gets its own lane and is deliberately kept serial by default.
export const analyticsTaskBudget = new BackgroundTaskBudget({
  maxConcurrent:Number(process.env.DASHBOARD_ANALYTICS_CONCURRENCY || 1),
  minGapMs:Number(process.env.DASHBOARD_ANALYTICS_GAP_MS || 300),
});

// Opportunity research has a bounded per-stock worker pool of its own. It
// must not sit behind option-chain or short-interest scans in analytics.
export const radarResearchTaskBudget = new BackgroundTaskBudget({
  maxConcurrent:1,
  minGapMs:Number(process.env.DASHBOARD_RADAR_RESEARCH_GAP_MS || 200),
});

// News and disclosure ingestion is network-bound but time-sensitive. It must not
// sit behind long, serial option-chain or short-interest scans in maintenance.
export const ingestionTaskBudget = new BackgroundTaskBudget({
  maxConcurrent:Number(process.env.DASHBOARD_INGESTION_CONCURRENCY || 1),
  minGapMs:Number(process.env.DASHBOARD_INGESTION_GAP_MS || 150),
});

export function enqueueBackgroundTask(name, task, options) {
  return backgroundTaskBudget.enqueue(name, task, options);
}

export function enqueueMaintenanceTask(name, task, options) {
  return maintenanceTaskBudget.enqueue(name, task, options);
}

export function enqueueAnalyticsTask(name, task, options) {
  return analyticsTaskBudget.enqueue(name, task, options);
}

export function enqueueRadarResearchTask(name, task, options) {
  return radarResearchTaskBudget.enqueue(name, task, options);
}

export function enqueueIngestionTask(name, task, options) {
  return ingestionTaskBudget.enqueue(name, task, options);
}

export function getBackgroundTaskStatus() {
  const market=backgroundTaskBudget.getStatus(),maintenance=maintenanceTaskBudget.getStatus(),analytics=analyticsTaskBudget.getStatus(),research=radarResearchTaskBudget.getStatus(),ingestion=ingestionTaskBudget.getStatus();
  const withLane=(items,lane)=>items.map(item=>({ ...item, lane }));
  return {
    maxConcurrent:market.maxConcurrent+maintenance.maxConcurrent+analytics.maxConcurrent+research.maxConcurrent+ingestion.maxConcurrent,
    running:[...withLane(market.running,'market'),...withLane(maintenance.running,'maintenance'),...withLane(analytics.running,'analytics'),...withLane(research.running,'research'),...withLane(ingestion.running,'ingestion')],
    queued:[...withLane(market.queued,'market'),...withLane(maintenance.queued,'maintenance'),...withLane(analytics.queued,'analytics'),...withLane(research.queued,'research'),...withLane(ingestion.queued,'ingestion')],
    recent:[...withLane(market.recent,'market'),...withLane(maintenance.recent,'maintenance'),...withLane(analytics.recent,'analytics'),...withLane(research.recent,'research'),...withLane(ingestion.recent,'ingestion')]
      .sort((left,right)=>Number(right.completedAt||right.startedAt||right.queuedAt)-Number(left.completedAt||left.startedAt||left.queuedAt)),
    lanes:{ market, maintenance, analytics, research, ingestion },
  };
}
