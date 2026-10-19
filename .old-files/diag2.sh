#!/bin/bash
echo "===== A. full xray config ====="
python3 - <<'PYEOF'
import json
c = json.load(open('/etc/xray/config.json'))
print(json.dumps(c, indent=2, ensure_ascii=False))
PYEOF

echo
echo "===== B. conns to 127.0.0.1:11111 : who connects from where ====="
ss -tn state established '( dport = :11111 )' | wc -l
ss -tnp state established '( dport = :11111 )' 2>/dev/null | awk 'NR>1 {print $5}' | awk -F. '{print $1"."$2"."$3"."$4}' | sort | uniq -c | sort -rn | head -10
echo "--- sample 5:"
ss -tnp state established '( dport = :11111 )' 2>/dev/null | head -6

echo
echo "===== C. conns to 2053 (vless inbound) ====="
ss -tn state established '( sport = :2053 or dport = :2053 )' | wc -l
ss -tnp state established '( sport = :2053 or dport = :2053 )' 2>/dev/null | head -6

echo
echo "===== D. conns to 7443 / 8080 / 10886 (relay, udp2raw) ====="
for p in 7443 8080 10886 80 443 8443 888 2087; do
  n=$(ss -tn state established "( sport = :$p or dport = :$p )" | wc -l)
  echo "port $p : $n"
done

echo
echo "===== E. who opens to 11111 : remote peer ports ====="
ss -tnp state established '( dport = :11111 )' 2>/dev/null | awk 'NR>1 {n=split($5,a,":"); print a[n]}' | sort | uniq -c | sort -rn | head -10

echo
echo "===== F. netstat sockets held by xray: state ====="
ss -tnp | grep 3862770 | awk '{print $1}' | sort | uniq -c

echo
echo "===== G. what is flooding /var/log/messages ====="
echo "--- last 15 lines:"
tail -15 /var/log/messages
echo "--- top 12 repeated patterns in messages:"
awk '{$1=$2=$3=""; sub(/^ +/,""); print}' /var/log/messages | sed 's/[0-9]\+/N/g' | sort | uniq -c | sort -rn | head -12
echo "--- last 10 lines of btmp:"
tail -10 /var/log/btmp

echo
echo "===== H. journal size & what it logs most ====="
journalctl --vacuum-time=1s --help >/dev/null 2>&1
journalctl --disk-usage 2>/dev/null
journalctl -p warning --no-pager -n 15 2>/dev/null | tail -15

echo
echo "===== I. nginx error log: top patterns ====="
awk '{$1=$2=$3=""; sub(/^ +/,""); print}' /www/wwwlogs/nginx_error.log | sed 's/[0-9][0-9]*\(\.[0-9][0-9]*\)*//g' | sort | uniq -c | sort -rn | head -8

echo
echo "===== J. SSH brute force evidence (secure) ====="
tail -6 /var/log/secure
grep -c "Failed password" /var/log/secure 2>/dev/null
grep -c "Invalid user" /var/log/secure 2>/dev/null

echo
echo "===== K. xray process limits / fd count ====="
ls /proc/3862770/fd 2>/dev/null | wc -l
cat /proc/3862770/limits 2>/dev/null | grep -i "open files"
cat /proc/3862770/status 2>/dev/null | grep -E "VmRSS|VmSwap|VmSize|Threads"

echo
echo "===== L. conntrack table (if used) ====="
cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo "no conntrack"
cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo "no conntrack_max"

echo
echo "===== M. tcp pressure ====="
cat /proc/net/sockstat
cat /proc/sys/net/ipv4/tcp_max_syn_backlog

echo "===== DONE ====="
