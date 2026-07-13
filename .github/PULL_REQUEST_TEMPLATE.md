## Summary

- Describe the problem and the outcome.

## Tracked work

- Task: <!-- Plasius-LTD/gpu-shader#... -->
- Parent Story/Feature: <!-- links in plasius-ltd-site -->
- Rollout flag: `asset.pipeline.shader-store.enabled`
- Capability impact: <!-- `gpu.shader.style.select`, default-only, or none -->

## Compatibility and qualification impact

- Model ABI impact: <!-- unchanged / changed with reason -->
- Shader ABI impact: <!-- unchanged / changed with reason -->
- Affected compile units/profiles/model fixtures:
- Full-inventory requalification trigger: <!-- yes/no and why -->

## Validation

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run test:coverage`
- [ ] Every changed source file appears in LCOV
- [ ] `npm run shader:matrix`
- [ ] `npm run pack:check`
- [ ] WGSL fragment inventory and required evidence updated when applicable

## Documentation and safety

- [ ] `README.md` and `CHANGELOG.md` updated when applicable
- [ ] ADR/TDR/design/runbook updated when architecture or operations changed
- [ ] No secrets, real PII, executable candidate content, or support claims
      unsupported by current physical evidence
- [ ] Browser-safe root export remains free of Node/automation dependencies

## Risks, rollout, and rollback

- Risks:
- Rollout:
- Rollback/fallback:
- Manual follow-up:
