# ASR Benchmark Harness

Work-in-progress harness for evaluating streaming ASR engines on Ragnar's Twilio audio path.

## Metrics
- `T_first_partial_ms`
- `T_final_ms`
- `WER/CER`
- `RT_factor`
- `partial_stability`
- `CPU/GPU`

## Test Sets
- 10 clean studio
- 10 phone narrowband
- 10 noisy/far-field
- 10 conversational

Audio normalized to 8k μ-law decoded → PCM16 16kHz.
