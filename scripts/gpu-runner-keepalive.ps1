# Keep the WSL GPU runner (and its sshd) alive so the observatory can reach it.
#
# WSL2 only runs on demand; when the last process exits the VM can shut down and
# the SSH listener disappears. This starts sshd (idempotent) and holds the distro
# open with a tail. Registered as a hidden per-user logon task by
# gpu-runner-register-keepalive.ps1; also safe to run by hand.
#
# Docs: docs/KANGAROO-GPU.md (Windows / WSL GPU runner)

wsl.exe -d Ubuntu-22.04 -u root -- bash -lc "service ssh start >/dev/null 2>&1; exec tail -f /dev/null"
