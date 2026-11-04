# Changelog

## 1.0.0 (2026-11-04)


### Features

* **auth:** H-06a sessions, API keys, CSRF, permission guards, login ([c63b50d](https://github.com/buschmjm/hearer/commit/c63b50d551a0db0d29cbe624bb35e675482b1513))
* **auth:** H-06b setup wizard, settings and users APIs, route matrix ([1df34c4](https://github.com/buschmjm/hearer/commit/1df34c49ed66487262900c07a6ed4816229f776b))
* **fulfillment:** H-12 provider interface, Manual and Lidarr providers, registry, poll job ([69be360](https://github.com/buschmjm/hearer/commit/69be360a8440681b3bd7ab043e34a5caec7e5043))
* H-22a release pipeline, deployment docs and the Playwright E2E harness ([ca1496f](https://github.com/buschmjm/hearer/commit/ca1496f55757040249d466f225f513f3d17038a4))
* **jellyfin:** H-07 Jellyfin adapter, login, user import, media server settings test ([afdf428](https://github.com/buschmjm/hearer/commit/afdf428e6c9b4bcc1f57e941645b2ad7ecfbcc67))
* **library:** H-10 library index sync, path mapping and availability matcher ([b516406](https://github.com/buschmjm/hearer/commit/b516406e603438b147540b6f207bb3a42baa3f2a))
* **metadata:** H-09 MusicBrainz and Cover Art Archive client, global rate limiter, cache, search API ([057c204](https://github.com/buschmjm/hearer/commit/057c204b30ff66f2476c9acdc4aeb1a4739483eb))
* **notifications:** H-21 agents, events, targets API, delivery job and per-user preferences ([17c4988](https://github.com/buschmjm/hearer/commit/17c4988f6130cea1ad2254b14c477ce411b304c2))
* **requests:** H-11 requests service, API, quotas, timeline, jobs and event bus ([462b915](https://github.com/buschmjm/hearer/commit/462b91571244d53b290f3c37bcd09cc754a46397))
* **server:** H-02 bootstrap, zod env config, health endpoint ([b2c9320](https://github.com/buschmjm/hearer/commit/b2c9320ee5a1366c9dc517383138430bc613833a))
* **server:** H-03a drizzle schema, initial migration, shared enums ([04771a6](https://github.com/buschmjm/hearer/commit/04771a645708af2e08c50a511b1845a97a536d40))
* **server:** H-03b typed settings store with encrypted secrets ([f76623c](https://github.com/buschmjm/hearer/commit/f76623c674b257adfe9519df25bc4f70952781dd))
* **server:** H-04 DB-backed job runner and maintenance job ([565b0e7](https://github.com/buschmjm/hearer/commit/565b0e7bf300cf43156b8bf1e3e7351cdf886720))
* **server:** OIDC login with PKCE, group policy and mock-IdP tests ([b842400](https://github.com/buschmjm/hearer/commit/b8424009cebee55a98ab9767e08721b54b230770))
* **uploads:** H-13 tus receive, validation, quotas, probe job, path sanitization ([f3bf1f1](https://github.com/buschmjm/hearer/commit/f3bf1f145a1c6c1d1fa129df71d5da51bb8ef566))
* **uploads:** H-14 analyze job with fingerprinting, AcoustID, candidate scoring, dedupe and review API ([8e171a4](https://github.com/buschmjm/hearer/commit/8e171a4b3c05578984d769a6c6c8443556fde82c))
* **uploads:** H-15 import with tag write, cover embed, path template, atomic move, rescan and request link ([0dd2550](https://github.com/buschmjm/hearer/commit/0dd255088ca520762aa4a58de9a9d1a83b909c5a))
* **web:** H-16a web shell, API client, auth pages, layout, static serving and CSP ([6f09c81](https://github.com/buschmjm/hearer/commit/6f09c8137663bc0019b0357d69dcda2ec85b8a3d))
* **web:** H-16b setup wizard with live template preview and resume ([149928e](https://github.com/buschmjm/hearer/commit/149928ec2513a52bef5f9cd949b5a0fd23cf2811))
* **web:** H-17 search, artist/album/track pages and request flow ([6af3549](https://github.com/buschmjm/hearer/commit/6af3549e581aa38383db299936d49e214f49b7bc))
* **web:** H-18 requests queue, my requests, detail and timeline ([53ffb81](https://github.com/buschmjm/hearer/commit/53ffb819593d7a6041c508da1e95edd86bd45607))
* **web:** H-19 upload dropzone with tus, uploads list, review and match editor, album batch review ([6dbe7af](https://github.com/buschmjm/hearer/commit/6dbe7af5da7ceee9b92c2a0c4fbd17b853c3c796))
* **web:** H-20 settings, users, jobs and account pages, schema-driven forms, jobs admin API ([e73bc43](https://github.com/buschmjm/hearer/commit/e73bc433b770423cbfadff147ad378f5dac57b99))


### Bug Fixes

* QA pass (duplicate match candidates, CSP for the cover art mirror, mobile bottom padding, flaky limiter test, route code splitting) ([31b3e9c](https://github.com/buschmjm/hearer/commit/31b3e9c8f3e6d35af2197914ef3eab4fd0fd5f72))
* **server:** lint in jobs retry ([dfb7930](https://github.com/buschmjm/hearer/commit/dfb79305a57808ce0e4ab4b9bc13db93ca8896ce))
