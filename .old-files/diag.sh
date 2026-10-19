#!/bin/bash
# diag.sh — resource / IO / connection diagnosis
echo "===== 1. CPU / iowait ====="
top -bn1 | head -12

echo
echo "===== 2. vmstat (4 samples) ====="
vmstat 1 4

echo
echo "===== 3. established conns by local port ====="
ss -tn state established | awk 'NR>1 {n=split($4,a,":"); print a[n]}' | sort | uniq -c | sort -rn | head -15

echo
echo "===== 4. established conns by process ====="
ss -tnp state established 2>/dev/null | grep -oE 'pid=[0-9]+' | sort | uniq -c | sort -rn | head -10

echo
echo "===== 5. established conns: top 10 remote peers ====="
ss -tn state established | awk 'NR>1 {print $5}' | sed 's/\[[^]]*\]//' | awk -F'[.:]' '{print $1}' | sort | uniq -c | sort -rn | head -10

echo
echo "===== 6. connection state breakdown ====="
ss -tn state established | wc -l
ss -tn state time-wait | wc -l

echo
echo "===== 7. per-process I/O (read/write bytes) ====="
for p in $(ls /proc | grep -E '^[0-9]+$'); do
  r=$(awk '/^read_bytes/{print $2}' /proc/$p/io 2>/dev/null)
  w=$(awk '/^write_bytes/{print $2}' /proc/$p/io 2>/dev/null)
  t=$(ps -p $p -o comm= 2>/dev/null)
  [ -n "$r" ] && [ -n "$w" ] && echo "$r $w $p $t"
done | sort -k1n -r | head -8 | awk '{printf "read=%.1fMB write=%.1fMB pid=%s %s\n", $1/1048576, $2/1048576, $3, $4}'
for p in $(ls /proc | grep -E '^[0-9]+$'); do
  w=$(awk '/^write_bytes/{print $2}' /proc/$p/io 2>/dev/null)
  t=$(ps -p $p -o comm= 2>/dev/null)
  [ -n "$w" ] && echo "$w $p $t"
done | sort -k1n -r | head -8 | awk '{printf "write=%.1fMB pid=%s %s\n", $1/1048576, $2, $3}'

echo
echo "===== 8. memory: RSS + swap per process ====="
for p in $(ls /proc | grep -E '^[0-9]+$'); do
  rss=$(awk '/^VmRSS/{print $2}' /proc/$p/status 2>/dev/null)
  sw=$(awk '/^VmSwap/{print $2}' /proc/$p/status 2>/dev/null)
  t=$(ps -p $p -o comm= 2>/dev/null)
  [ -n "$rss" ] && echo "$((rss+sw)) $rss $sw $p $t"
done | sort -rn | head -12 | awk '{printf "rss=%5.0fMB swap=%5.0fMB  pid=%-8s %s\n", $2/1024, $3/1024, $4, $5}'

echo
echo "===== 9. /var/log largest ====="
du -xcm /var/log 2>/dev/null | sort -rn | head -8
ls -lhS /var/log | head -12

echo
echo "===== 10. xray / x-ui config ====="
ls -l /etc/xray/config.json 2>/dev/null
echo "--- inbounds count:"; grep -oE '"tag"' /etc/xray/config.json 2>/dev/null | wc -l
echo "--- inbound types:"; python3 -c "
import json,sys
c=json.load(open('/etc/xray/config.json'))
for i in c.get('inbounds',[]):
    print(i.get('port'), i.get('listen'), i.get('protocol'), i.get('tag'))
" 2>/dev/null
echo "--- outbounds:"; python3 -c "
import json
c=json.load(open('/etc/xray/config.json'))
for o in c.get('outbounds',[]):
    print(o.get('protocol'), o.get('tag'))
" 2>/dev/null
echo "--- xray log dir:"; ls -lh /usr/local/x-ui/bin/ 2>/dev/null | head; ls -lh /usr/local/x-ui 2>/dev/null | head

echo
echo "===== 11. disk IO in flight / writeback ====="
cat /proc/vmstat | grep -E '^(pgpgin|pgpgout|pswpin|pswpout|dirty|writeback|nr_written) '

echo
echo "===== 12. kernel scheduler / disk model ====="
cat /sys/block/vda/queue/scheduler 2>/dev/null
cat /sys/block/vda/queue/nr_requests 2>/dev/null
cat /sys/block/vda/queue/read_ahead_kb 2>/dev/null

echo
echo "===== 13. cgroup OOM / throttling ====="
dmesg -T 2>/dev/null | grep -iE 'oom|killed process|throttl|blk-throttl' | tail -20

echo
echo "===== 14. docker containers ====="
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null

echo
echo "===== 15. BT panel / nginx log growth ====="
ls -lh /www/wwwlogs 2>/dev/null | head -12
du -xcm /www/wwwlogs 2>/dev/null | sort -rn | head -5

echo "===== DONE ====="
