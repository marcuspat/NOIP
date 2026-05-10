// FeedbackService — `POST /ai/feedback/:analysisId` handler.
//
// Records analyst feedback against the relevant LearningPatterns. The
// signal is extracted from the analysis's insights: every insight whose
// signature matches an existing pattern is reinforced (positive
// feedback) or weakened (negative).

import type { AnalysisId } from '../../../shared/kernel';
import { NotFoundError, ValidationError } from '../../../shared/errors';
import type { AnalysisRepository } from '../infrastructure/persistence/analysis.repository';
import type { LearningPatternRepository } from '../infrastructure/persistence/learning-pattern.repository';
import { PatternLearner } from './pattern-learner';
import type { LearningPattern } from '../domain/learning-pattern';

export interface FeedbackRecord {
  analysisId: AnalysisId;
  useful: boolean;
  comment?: string;
  patternsTouched: number;
}

export interface FeedbackServiceOptions {
  analyses: AnalysisRepository;
  patterns: LearningPatternRepository;
  learner: PatternLearner;
}

export class FeedbackService {
  private readonly analyses: AnalysisRepository;
  private readonly patterns: LearningPatternRepository;
  private readonly learner: PatternLearner;

  constructor(opts: FeedbackServiceOptions) {
    this.analyses = opts.analyses;
    this.patterns = opts.patterns;
    this.learner = opts.learner;
  }

  async record(
    analysisId: AnalysisId,
    useful: boolean,
    comment?: string
  ): Promise<FeedbackRecord> {
    if (!analysisId || typeof analysisId !== 'string') {
      throw new ValidationError('analysisId is required');
    }
    const analysis = await this.analyses.findById(analysisId);
    if (!analysis) throw new NotFoundError('Analysis', analysisId);

    let touched = 0;
    const seen = new Set<string>();
    for (const insight of analysis.insights) {
      const signature = this.learner.signatureFor(insight.text);
      if (seen.has(signature)) continue;
      seen.add(signature);
      const pattern = await this.patterns.findBySignature(
        signature,
        analysis.type
      );
      if (!pattern) continue;
      const updated: LearningPattern = useful
        ? await this.learner.reinforce(pattern.id)
        : await this.learner.weaken(pattern.id);
      void updated;
      touched += 1;
    }

    return {
      analysisId,
      useful,
      ...(comment !== undefined ? { comment } : {}),
      patternsTouched: touched,
    };
  }
}
