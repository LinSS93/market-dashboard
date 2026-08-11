# Public release checklist

- [ ] Confirm the code license is appropriate for every contributor.
- [ ] Review current provider terms and redistribution restrictions.
- [ ] Run `npm run verify:public:strict` in a freshly generated candidate and inspect every failure.
- [ ] Run `npm ci && npm run check:all` in a clean directory.
- [ ] Publish a new sanitized Git repository rather than private operational history.
- [ ] Verify all background producers and LLM features are disabled by default.
- [ ] Review documentation, fixtures, and screenshots for private material.
- [ ] Enable private vulnerability reporting and CI before publication.
