# Community admin

Nothing listed in Community is reviewed. A publisher's build of a public, open-source commit is listed as soon as it is published, and whoever installs it reads what it can reach on their own machine first. Tomrade keeps two powers, both here:

- **revoke** a plugin that reports show to be malicious: machines switch it off at their next check;
- **sign** one of Tomrade's own plugins as **official**, with the store key whose public half is in `apps/desktop/src/trust.ts`.

```sh
tomrade-store reports                                   # open reports
tomrade-store show alice/notes@1.2.0                    # a listed version as the store holds it
tomrade-store official tomrade-app/pet@1.0.0            # STORE_SIGNING_KEY or STORE_SIGNING_KEY_FILE
tomrade-store revoke alice/notes --versions ">=1.2.0" --reason "exfiltrates data"
tomrade-store keygen --out <safe place>                 # a new store key
```

It also reads the **troubleshooting reports** people send from the app (Troubleshoot → Send to the developer). A report holds only what its sender read and ticked; the same failure seen by many people shares a fingerprint.

```sh
tomrade-store diag                                      # new reports, grouped by fingerprint, most common first
tomrade-store diag --all                                # every status
tomrade-store diag R-7K3F2A                             # one report, section by section
```

Every command but `keygen` needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
