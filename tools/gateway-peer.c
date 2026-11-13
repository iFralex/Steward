/* Resolve a loopback TCP client on macOS. No argv, environment or payloads. */
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
static void string(const char *s) {
  putchar('"'); for (; *s; s++) { unsigned char c=*s; if(c=='"'||c=='\\')putchar('\\'); if(c>=32)putchar(c); } putchar('"');
}
static void output(pid_t pid) {
  printf("{\"status\":\"matched\",\"chain\":[");
  for(int depth=0;pid>1&&depth<4;depth++) {
    struct proc_bsdinfo info={0};char path[PROC_PIDPATHINFO_MAXSIZE]={0};
    if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=(int)sizeof(info))break;
    proc_pidpath(pid,path,sizeof(path));
    if(depth)putchar(',');printf("{\"pid\":%d,\"ppid\":%d,\"executable\":",pid,info.pbi_ppid);string(path);putchar('}');pid=info.pbi_ppid;
  }
  puts("]}");
}
int main(int argc,char **argv) {
  if(argc!=3)return 2;
  int client=atoi(argv[1]),server=atoi(argv[2]);if(client<1||client>65535||server<1||server>65535)return 2;
  int cap=proc_listallpids(NULL,0)*2+64;pid_t *pids=calloc(cap,sizeof(pid_t));if(!pids)return 1;
  int n=proc_listallpids(pids,cap*sizeof(pid_t));if(n>cap)n=cap;
  for(int i=0;i<n;i++) {
    pid_t pid=pids[i];struct proc_bsdinfo bsd={0};
    if(pid<=1||pid==getpid()||proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&bsd,sizeof(bsd))!=(int)sizeof(bsd)||bsd.pbi_uid!=getuid())continue;
    int bytes=proc_pidinfo(pid,PROC_PIDLISTFDS,0,NULL,0);if(bytes<=0)continue;
    struct proc_fdinfo *fds=malloc(bytes);if(!fds)continue;
    int actual=proc_pidinfo(pid,PROC_PIDLISTFDS,0,fds,bytes);
    for(int j=0;j<actual/(int)sizeof(*fds);j++) {
      if(fds[j].proc_fdtype!=PROX_FDTYPE_SOCKET)continue;
      struct socket_fdinfo sock={0};
      if(proc_pidfdinfo(pid,fds[j].proc_fd,PROC_PIDFDSOCKETINFO,&sock,sizeof(sock))!=(int)sizeof(sock)||sock.psi.soi_kind!=SOCKINFO_TCP||sock.psi.soi_family!=AF_INET)continue;
      struct in_sockinfo *in=&sock.psi.soi_proto.pri_tcp.tcpsi_ini;
      if(ntohs((uint16_t)in->insi_lport)==client&&ntohs((uint16_t)in->insi_fport)==server&&ntohl(in->insi_faddr.ina_46.i46a_addr4.s_addr)==0x7f000001) {
        output(pid);free(fds);free(pids);return 0;
      }
    }
    free(fds);
  }
  free(pids);puts("{\"status\":\"not-found\"}");return 0;
}
