# Decisions

## Job queue on SQLite

We moved the job queue from Redis to SQLite because the deploy target has no
persistent volume for Redis and we only run one worker. SQLite in WAL mode
handles our write rate easily, and it keeps backups to a single file.

## Tabs in Go files

Go files use tabs because gofmt enforces it. Do not reformat them with spaces.
