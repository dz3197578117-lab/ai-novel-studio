#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Minimal SSH runner using paramiko. Usage: python sshx.py "command" [command2 ...]"""
import sys
import paramiko

HOST = "47.80.8.246"
PORT = 22
USER = "root"
PASSWORD = "Dz@944255."


def main():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if len(sys.argv) > 1 and sys.argv[1] == "--run-local":
        # upload a local script and execute it as bash on the remote
        local = sys.argv[2]
        remote = "/tmp/" + local.rsplit("/", 1)[-1].replace("\\", "/")
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(HOST, port=PORT, username=USER, password=PASSWORD,
                       timeout=20, allow_agent=False, look_for_keys=False)
        with open(local, "rb") as f:
            data = f.read().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        sftp = client.open_sftp()
        with sftp.open(remote, "wb") as rf:
            rf.write(data)
        sftp.close()
        print("=== uploaded %s -> %s ===" % (local, remote))
        out_path = sys.argv[3] if len(sys.argv) > 3 else "out.txt"
        _, stdout, stderr = client.exec_command("bash %s" % remote, timeout=600)
        data = stdout.read()
        err = stderr.read()
        with open(out_path, "wb") as f:
            f.write(data)
            if err:
                f.write(b"\n[stderr]\n" + err)
        print("=== wrote %d bytes -> %s ===" % (len(data) + len(err), out_path))
        client.close()
        return
    cmds = sys.argv[1:] or ["uname -a"]
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        HOST,
        port=PORT,
        username=USER,
        password=PASSWORD,
        timeout=20,
        banner_timeout=20,
        auth_timeout=20,
        allow_agent=False,
        look_for_keys=False,
    )
    for c in cmds:
        sys.stdout.write("=== $ %s\n" % c)
        stdin, stdout, stderr = client.exec_command(c, timeout=300, get_pty=False)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        rc = stdout.channel.recv_exit_status()
        sys.stdout.write(out)
        if err.strip():
            sys.stdout.write("[stderr]\n" + err)
        sys.stdout.write("[exit %d]\n" % rc)
        sys.stdout.flush()
    client.close()


if __name__ == "__main__":
    main()
