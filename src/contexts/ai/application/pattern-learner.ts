// PatternLearner — observes recurring `Insight` shapes and emits or
// updates `LearningPattern` aggregates.
//
// A signature is a normalised form of the insight text (lowercase,
// digits stripped, ids opaqued) hashed with SHA-1. When the same
// signature is observed N times it crosses the recurrence threshold
// and a LearningPattern is created (or its `observe()` is called).
//
// The FeedbackService delegates `reinforce` / `weaken` calls to this
// service so all writes live in one place.

import { createHash } from 'node:crypto';
import type { Clock, EventBus, PatternId } from '../../../shared/kernel';
import { LearningPattern } from '../domain/learning-pattern';
import type { Insight } from '../domain/value-objects';
import type { LearningPatternRepository } from '../infrastructure/persistence/learning-pattern.repository';
import { NotFoundError } from '../../../shared/errors';

export interface PatternLearnerOptions {
  patterns: LearningPatternRepository;
  bus: EventBus;
  clock: Clock;
  /** Recurrence threshold; default 3. */
  recurrenceThreshold?: number;
  /** Confidence floor below which a pattern is soft-deleted. Default 0.3. */
  confidenceThreshold?: number;
}

interface ObservationCounter {
  signature: string;
  count: number;
  exemplar: string;
  type: string;
}

export class PatternLearner {
  private readonly patterns: LearningPatternRepository;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly recurrenceThreshold: number;
  private readonly confidenceThreshold: number;
  /** In-memory pre-pattern observation counter (transient by design). */
  private readonly counters = new Map<string, ObservationCounter>();

  constructor(opts: PatternLearnerOptions) {
    this.patterns = opts.patterns;
    this.bus = opts.bus;
    this.clock = opts.clock;
    this.recurrenceThreshold = opts.recurrenceThreshold ?? 3;
    this.confidenceThreshold = opts.confidenceThreshold ?? 0.3;
  }

  /**
   * Observe the insights produced by an analysis. Returns the patterns
   * that were created or reinforced as a result.
   */
  async observeInsights(args: {
    type: string;
    insights: ReadonlyArray<Insight>;
  }): Promise<LearningPattern[]> {
    const touched: LearningPattern[] = [];
    for (const insight of args.insights) {
      const signature = this.signatureFor(insight.text);
      const existing = await this.patterns.findBySignature(
        signature,
        args.type
      );
      if (existing) {
        existing.observe(this.clock);
        await this.patterns.save(existing);
        this.bus.publishMany(existing.drainEvents());
        touched.push(existing);
        continue;
      }
      const c = this.counters.get(signature);
      if (c) {
        c.count += 1;
      } else {
        this.counters.set(signature, {
          signature,
          count: 1,
          exemplar: insight.text,
          type: args.type,
        });
      }
      const counter = this.counters.get(signature)!;
      if (counter.count >= this.recurrenceThreshold) {
        const created = LearningPattern.create(
          {
            type: args.type,
            pattern: counter.exemplar,
            signature,
            confidence: 0.6,
          },
          this.clock
        );
        await this.patterns.save(created);
        this.bus.publishMany(created.drainEvents());
        this.counters.delete(signature);
        touched.push(created);
      }
    }
    return touched;
  }

  async reinforce(id: PatternId): Promise<LearningPattern> {
    const p = await this.patterns.findById(id);
    if (!p) throw new NotFoundError('LearningPattern', id);
    p.reinforce(this.clock);
    await this.patterns.save(p);
    this.bus.publishMany(p.drainEvents());
    return p;
  }

  async weaken(id: PatternId): Promise<LearningPattern> {
    const p = await this.patterns.findById(id);
    if (!p) throw new NotFoundError('LearningPattern', id);
    p.weaken(this.clock, this.confidenceThreshold);
    await this.patterns.save(p);
    this.bus.publishMany(p.drainEvents());
    return p;
  }

  /**
   * Compute a stable signature: lowercase, strip digits + uuid-like
   * tokens + opaque ids, collapse whitespace, then SHA-1.
   */
  signatureFor(text: string): string {
    const normalised = text
      .toLowerCase()
      .replace(/op_[a-z0-9]+/g, '')
      .replace(
        /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g,
        ''
      )
      .replace(/<redacted:[^>]*>/g, '')
      .replace(/<pii:[^>]*>/g, '')
      .replace(/[0-9]+/g, '')
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return 'sha1:' + createHash('sha1').update(normalised).digest('hex');
  }
}
