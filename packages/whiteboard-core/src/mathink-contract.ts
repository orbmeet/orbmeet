import * as v from "valibot";
import {
  MATHINK_MAX_COORDINATE,
  MATHINK_MAX_RAW_POINTS,
  MATHINK_MAX_STROKES,
} from "./mathink-constants.ts";

export * from "./mathink-constants.ts";

const coordinateSchema = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(-MATHINK_MAX_COORDINATE),
  v.maxValue(MATHINK_MAX_COORDINATE),
);
const pointSchema = v.strictTuple([coordinateSchema, coordinateSchema]);
const strokeSchema = v.pipe(v.array(pointSchema), v.nonEmpty(), v.maxLength(MATHINK_MAX_RAW_POINTS));

export const mathInkRequestSchema = v.strictObject({
  strokes: v.pipe(
    v.array(strokeSchema),
    v.nonEmpty(),
    v.maxLength(MATHINK_MAX_STROKES),
    v.check(
      (strokes) => strokes.reduce((total, stroke) => total + stroke.length, 0) <= MATHINK_MAX_RAW_POINTS,
      `Math ink input may contain at most ${MATHINK_MAX_RAW_POINTS} points`,
    ),
  ),
});

export const mathInkRecognitionResponseSchema = v.object({
  latex: v.pipe(v.string(), v.nonEmpty(), v.maxLength(20_000)),
  model_step: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  latency_ms: v.pipe(v.number(), v.finite(), v.minValue(0)),
});
