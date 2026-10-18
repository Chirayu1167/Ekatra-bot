# Live Twilio journey checklist

Use only after a human has selected the Twilio account, approved sender/templates, staging host,
and test recipients and has confirmed consent. Do not run against real learners without an
explicit operational authorization. Record no full phone numbers, secrets, or message contents
in this checklist.

| Step | Expected result | Pass/fail | Notes |
| --- | --- | --- | --- |
| Publish a course | Published course is visible to the intended organisation; excluded course fields are absent. |  |  |
| Enroll with consent | Enrollment is accepted only after the required WhatsApp consent is recorded. |  |  |
| Set a schedule | Selected timezone and schedule preview match the intended local send times. |  |  |
| Receive lessons | Test learner receives one lesson at a time; progress advances only after confirmed delivery. |  |  |
| Correct quiz answer | Correct feedback is delivered once, including the configured explanation when present. |  |  |
| Incorrect quiz answer | Incorrect feedback is delivered once, including the configured explanation when present. |  |  |
| Pause | Paused enrollment receives no scheduled or requested lesson sends. |  |  |
| Resume | Resumed enrollment continues from the expected lesson without a duplicate. |  |  |
| STOP | Opt-out is durably recorded and no subsequent course message is sent. |  |  |
| START | Explicit re-subscription is acknowledged and subsequent delivery follows the consent policy. |  |  |
| Worker restart mid-course | Worker restarts and continues safely without skipped or duplicated progress. |  |  |
| Forced delivery failure | Failure appears in `/console` → Failures with attempts and a safe reason. |  |  |
| Replay failure | After correcting the cause, replay results in one successful delivery and no duplicate progress. |  |  |
| Complete course | Completion is recorded once and exactly one certificate is issued. |  |  |

**Evidence to retain:** date/time, deployment version, sanitized course/enrollment identifiers,
screen/result, and operator initials. Do not record recipient phone numbers, credentials,
webhook signatures, or private message text.
