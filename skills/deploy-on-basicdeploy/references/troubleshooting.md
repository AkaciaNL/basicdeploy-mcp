# BasicDeploy — deploy troubleshooting

- **Public URL returns 503:** the app is not listening on `0.0.0.0:8080`. Fix the port/binding
  (not localhost, not 3000/5000). The routing is wired at container creation; you do NOT need
  `deploy_app` to "register" the app.
- **Logs are empty (`get_logs`):** the app was started as a child of `exec_command`. Run it as
  the container's main process so its stdout/stderr reach the log stream.
- **App sleeps / stops responding:** long-running servers need always-on (`set_always_on`).
  Without it the container sleeps when idle and the process is not relaunched.
- **Browser can't reach the database or S3:** those hostnames are cluster-internal. Access them
  from inside the container; proxy media through your app.
- **`deploy_app` can't find the tarball (remote/chat):** no shared filesystem — deploy with
  `exec_command` instead.
