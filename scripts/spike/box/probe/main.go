// box-probe: a tiny static helper copied into the spike root filesystem. Each subcommand
// exercises one sandbox property (Unix socket, loopback, memory, pids, cpu, disk).
package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: box-probe <cmd>")
		os.Exit(2)
	}
	a := os.Args[2:]
	switch os.Args[1] {
	case "uds-client": // uds-client PATH
		c, err := net.Dial("unix", a[0])
		if err != nil {
			fmt.Println("DIAL-ERR", err)
			os.Exit(1)
		}
		fmt.Fprintf(c, "ping\n")
		l, _ := bufio.NewReader(c).ReadString('\n')
		fmt.Print("REPLY ", l)
	case "loopback": // listen on 127.0.0.1:PORT, dial it, echo
		port := a[0]
		ln, err := net.Listen("tcp", "127.0.0.1:"+port)
		if err != nil {
			fmt.Println("LISTEN-ERR", err)
			os.Exit(1)
		}
		go func() {
			c, _ := ln.Accept()
			io.Copy(c, c)
		}()
		c, err := net.Dial("tcp", "127.0.0.1:"+port)
		if err != nil {
			fmt.Println("DIAL-ERR", err)
			os.Exit(1)
		}
		fmt.Fprintf(c, "hello\n")
		l, _ := bufio.NewReader(c).ReadString('\n')
		fmt.Print("LOOPBACK-ECHO ", l)
		_, err = net.DialTimeout("tcp", "93.184.216.34:80", 2*time.Second)
		fmt.Println("EXTERNAL-DIAL", err)
	case "alloc": // alloc MB: touch memory in 10 MB steps, print each step
		mb, _ := strconv.Atoi(a[0])
		var keep [][]byte
		for i := 10; i <= mb; i += 10 {
			b := make([]byte, 10<<20)
			for j := 0; j < len(b); j += 4096 {
				b[j] = 1
			}
			keep = append(keep, b)
			if i%100 == 0 {
				fmt.Println("ALLOC", i)
			}
		}
		fmt.Println("ALLOC-DONE", mb)
		if len(a) > 1 { // hold
			time.Sleep(time.Duration(mustAtoi(a[1])) * time.Second)
		}
		_ = keep
	case "fork": // fork N sleepers, count how many succeed
		n, _ := strconv.Atoi(a[0])
		ok := 0
		for i := 0; i < n; i++ {
			c := exec.Command("/bin/sleep", "5")
			if err := c.Start(); err != nil {
				fmt.Println("FORK-FAIL-AT", ok, err)
				break
			}
			ok++
		}
		fmt.Println("FORKED", ok)
	case "busy": // busy SECS: spin on 4 goroutines, report process CPU time vs wall
		secs, _ := strconv.Atoi(a[0])
		done := make(chan bool)
		for i := 0; i < 4; i++ {
			go func() {
				for {
					select {
					case <-done:
						return
					default:
					}
				}
			}()
		}
		t0 := time.Now()
		time.Sleep(time.Duration(secs) * time.Second)
		close(done)
		var ru syscall.Rusage
		syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
		cpu := float64(ru.Utime.Sec) + float64(ru.Utime.Usec)/1e6 + float64(ru.Stime.Sec) + float64(ru.Stime.Usec)/1e6
		wall := time.Since(t0).Seconds()
		fmt.Printf("BUSY wall=%.2f cpu=%.2f cores=%.2f gomaxprocs=%d\n", wall, cpu, cpu/wall, runtime.GOMAXPROCS(0))
	case "relay": // relay LISTEN_TCP_ADDR UDS_PATH : the in-sandbox end of a host Unix socket (box-init's job)
		relay(a[0], a[1])
	case "init": // PID 1 of a sandbox: the two relays, then sleep forever
		go relay("127.0.0.1:3129", "/run/slaude/llm.sock")
		go relay("127.0.0.1:3128", "/run/slaude/egress.sock")
		select {}
	case "write": // write PATH MB
		mb, _ := strconv.Atoi(a[1])
		f, err := os.Create(a[0])
		if err != nil {
			fmt.Println("CREATE-ERR", err)
			os.Exit(1)
		}
		buf := make([]byte, 1<<20)
		for i := range buf {
			buf[i] = byte(i * 7)
		}
		for i := 0; i < mb; i++ {
			if _, err := f.Write(buf); err != nil {
				fmt.Println("WRITE-ERR-AT-MB", i, err)
				f.Close()
				os.Exit(1)
			}
		}
		if err := f.Sync(); err != nil {
			fmt.Println("SYNC-ERR", err)
		}
		f.Close()
		fmt.Println("WROTE-MB", mb)
	}
}

func mustAtoi(s string) int { n, _ := strconv.Atoi(s); return n }

func relay(listen, uds string) {
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		fmt.Println("RELAY-LISTEN-ERR", err)
		os.Exit(1)
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			u, err := net.Dial("unix", uds)
			if err != nil {
				c.Close()
				return
			}
			go func() { io.Copy(u, c); u.(*net.UnixConn).CloseWrite() }()
			io.Copy(c, u)
			c.Close()
			u.Close()
		}()
	}
}
