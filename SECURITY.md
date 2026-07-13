# Security policy

## Supported versions

The package has not yet been released from this repository. After the first
approved release, the latest major version will receive security updates; older
majors may not.

| Version | Supported |
| --- | --- |
| Unreleased development branch | Best effort; not a production support claim |

## Reporting a vulnerability

Email [security@plasius.co.uk](mailto:security@plasius.co.uk). Do not disclose a
vulnerability in a public issue, discussion, pull request, qualification
fixture, shader diagnostic, or CI log.

Include the affected package version/commit, environment, reproduction steps,
impact, and a safe minimal proof when possible. Do not include real credentials,
personal data, destructive payloads, or executable candidate archives.

We aim to acknowledge a report within two business days and provide initial
assessment/next steps within seven business days. We will coordinate disclosure
after a fix and affected release are available.

## Relevant security boundaries

Reports are especially useful for:

- manifest, canonicalization, digest or ABI validation bypass;
- loading unpromoted assets or arbitrary Blob URLs;
- path traversal, archive confusion or executable content accepted as a
  qualification candidate;
- code execution or credential access on physical runner hosts;
- evidence replay, stale/duplicate/missing result acceptance or provenance
  confusion;
- unbounded allocation, execution or denial of service in codecs, parsers,
  reflection, runtime loading or fixture interpretation; and
- browser/Node export-boundary mistakes that expose privileged dependencies or
  APIs to browser consumers.

Never test against production storage, catalogs, devices or runners without
explicit authorization.
