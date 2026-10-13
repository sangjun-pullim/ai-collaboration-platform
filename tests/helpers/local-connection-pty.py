import json, os, pty, select, signal, sys, time

fixture = json.loads(sys.stdin.readline())
pid, terminal = pty.fork()
if pid == 0:
    os.execve('/bin/zsh', ['zsh', '-f', '-c', fixture['command']], fixture['environment'])
output = b''
answered = set()
deadline = time.monotonic() + 35
status = None
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([terminal, sys.stdin], [], [], 0.1)
        if terminal in ready:
            try:
                output += os.read(terminal, 65536)
            except OSError:
                pass
        if sys.stdin in ready and sys.stdin.readline().strip() == 'stop':
            os.write(terminal, b'\x03')
        text = output.decode(errors='replace')
        for marker, answer in [('yes를 입력하세요:', 'yes'), ('revoked를 입력하세요:', 'revoked'), ('restart를 입력하세요', 'restart')]:
            if marker in text and marker not in answered:
                os.write(terminal, (answer + '\n').encode())
                answered.add(marker)
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            break
        status = None
    if status is None:
        os.killpg(pid, signal.SIGTERM)
        _, status = os.waitpid(pid, 0)
    print(json.dumps({'exitCode': os.waitstatus_to_exitcode(status), 'output': output.decode(errors='replace')}))
finally:
    os.close(terminal)
