/* Upload first, transmit locally: serial bandwidth never creates gaps between
 * RMT halves. A bounded encoded buffer expands to many hardware-buffer lengths. */
#include "rmt.h"
#include "rmt_port.h"
#include "platform.h"
#include "sdmmc.h"
#if STUB_HAS_RMT || defined(RPC_RMT_TEST)
static uint8_t data[4096];
static uint32_t dictionary[2],encoding,symbols,bytes,used,hz;
static unsigned active,channel,prepared;
static rpc_peripheral_response_t reply;
static uint32_t word(unsigned index){
    if(encoding==RPC_RMTENCODINGS_BITMAP)return dictionary[(data[index/8]>>(7-index%8))&1];
    const uint8_t *p=data+index*4;return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;
}
static unsigned ticks(uint32_t w){return (w&32767)+((w>>16)&32767);}
static int valid(uint32_t w){return (w&32767)&&((w>>16)&32767);}
static void fail(unsigned status,unsigned error){reply.status=status;reply.error=error;}
static void send(const rpc_peripheral_command_t *q){
    unsigned repeat=q->args[0],idle=q->args[1],size=hw_rmt_words(),half=size/2;
    if(!prepared||used!=bytes||!repeat||repeat>1000||idle>1000000){fail(RPC_STATUS_BAD_ARGUMENT,RPC_PERIPHERALERRORS_BAD_SEQUENCE);return;}
    uint64_t total_ticks=0;
    for(unsigned i=0;i<symbols;i++){uint32_t w=word(i);if(!valid(w)||(symbols*repeat>=size&&ticks(w)<(hz+999999)/1000000)){fail(RPC_STATUS_BAD_ARGUMENT,RPC_PERIPHERALERRORS_BAD_SEQUENCE);return;}total_ticks+=ticks(w);}
    uint64_t duration=(total_ticks*repeat*1000000u+hz-1)/hz+idle;
    if(duration>q->timeout_us){fail(RPC_STATUS_BAD_ARGUMENT,RPC_PERIPHERALERRORS_BAD_TIMEOUT);return;}
    uint32_t cpu_hz=hw_rmt_cpu_hz();
    uint64_t half_ticks[2]={0,0},elapsed=0,budget=(uint64_t)q->timeout_us*cpu_hz/1000000u;
    unsigned total=symbols*repeat,position=0,index=0,refills=0,next=0,sentinel=0;
    hw_rmt_prepare(channel);
    for(unsigned i=0;i<size;i++){
        uint32_t w=0;if(position<total){w=word(index);if(++index==symbols)index=0;position++;half_ticks[i/half]+=ticks(w);}else sentinel=1;
        hw_rmt_write(channel,i,w);
    }
    uint64_t threshold=half_ticks[0];uint32_t previous=platform_cycles();hw_rmt_start(channel);
    for(;;){
        unsigned event=hw_rmt_events(channel);uint32_t now=platform_cycles();elapsed+=(uint32_t)(now-previous);previous=now;
        if(event&4){fail(RPC_STATUS_IO_ERROR,RPC_PERIPHERALERRORS_UNDERRUN);break;}
        if(event&1){if(!sentinel||position!=total)fail(RPC_STATUS_IO_ERROR,RPC_PERIPHERALERRORS_UNDERRUN);break;}
        if(elapsed>=budget){fail(RPC_STATUS_TIMEOUT,RPC_PERIPHERALERRORS_TIMEOUT);break;}
        if(event&2){
            hw_rmt_clear(channel,2);
            if(!sentinel){
                uint64_t boundary=threshold+half_ticks[next^1];
                /* Compare rational clock domains without truncating cycles per
                 * RMT tick (e.g. 53 MHz CPU / 20 MHz RMT), or rounding drift. */
                uint64_t deadline=boundary*cpu_hz;
                if(elapsed*hz>=deadline){fail(RPC_STATUS_IO_ERROR,RPC_PERIPHERALERRORS_UNDERRUN);break;}
                half_ticks[next]=0;
                for(unsigned i=0;i<half;i++){
                    uint32_t w=0;if(position<total){w=word(index);if(++index==symbols)index=0;position++;half_ticks[next]+=ticks(w);}else sentinel=1;
                    hw_rmt_write(channel,next*half+i,w);
                }
                now=platform_cycles();elapsed+=(uint32_t)(now-previous);previous=now;
                if(elapsed*hz>=deadline){fail(RPC_STATUS_IO_ERROR,RPC_PERIPHERALERRORS_UNDERRUN);break;}
                threshold=boundary;next^=1;refills++;
            }
        }
    }
    hw_rmt_stop(channel);
    if(!reply.status&&idle)platform_delay(idle);
    reply.values[0]=reply.status?0:total;reply.values[1]=refills;reply.values[2]=(uint32_t)duration;reply.values[3]=used;
}
uint32_t rpc_rmt_capabilities(void){return 1u<<RPC_CAPABILITIES_RMT;}
int rpc_rmt_handle(const rpc_header_t *request,uint32_t length){
    if(request->magic[0]!='R'||request->magic[1]!='M'||request->magic[2]!='T'||request->magic[3]!='C')return 0;
    reply=(rpc_peripheral_response_t){0};reply.header=(rpc_header_t){{'R','M','T','R'},sizeof(reply)};
    if(length<sizeof(rpc_peripheral_command_t)){fail(RPC_STATUS_BAD_LENGTH,0);goto done;}
    const rpc_peripheral_command_t *q=(const void *)request;reply.operation=q->operation;reply.port=q->port;reply.actual_hz=hz;
    unsigned n=length-sizeof(*q);
    if(q->port>=hw_rmt_count()){fail(RPC_STATUS_BAD_ARGUMENT,RPC_PERIPHERALERRORS_BAD_PORT);goto done;}
    if(q->timeout_us<100||q->timeout_us>30000000){fail(RPC_STATUS_BAD_ARGUMENT,RPC_PERIPHERALERRORS_BAD_TIMEOUT);goto done;}
    if(q->operation==RPC_OPERATIONS_INFO){uint32_t v[8];hw_rmt_info(q->port,v);for(unsigned i=0;i<8;i++)reply.values[i]=v[i];goto done;}
    if(q->operation==RPC_OPERATIONS_CONFIGURE){
        if(n||!q->args[0]||q->args[0]>80000000||q->args[1]>1){fail(RPC_STATUS_BAD_ARGUMENT,0);goto done;}
        if(active&&channel!=q->port){fail(RPC_STATUS_IO_ERROR,RPC_PERIPHERALERRORS_BUSY);goto done;}
        hz=hw_rmt_config(q->port,q->args[0],q->args[1]);if(!hz){fail(RPC_STATUS_BAD_ARGUMENT,RPC_PERIPHERALERRORS_BAD_CLOCK);goto done;}
        active=1;channel=q->port;prepared=0;used=0;reply.actual_hz=hz;goto done;
    }
    if(q->operation==RPC_OPERATIONS_RELEASE){if(active&&channel==q->port){hw_rmt_release(channel);active=prepared=used=0;}goto done;}
    if(!active||channel!=q->port){fail(RPC_STATUS_IO_ERROR,RPC_PERIPHERALERRORS_NOT_CONFIGURED);goto done;}
    if(q->operation==RPC_RMTOPERATIONS_BEGIN){
        uint32_t enc=q->args[0],count=q->args[1],len=q->args[2];
        if(n||enc>1||!count||count>32768||len>sizeof(data)||len!=(enc?(count+7)/8:count*4)){fail(RPC_STATUS_BAD_ARGUMENT,RPC_PERIPHERALERRORS_BAD_SEQUENCE);goto done;}
        encoding=enc;symbols=count;bytes=len;dictionary[0]=q->args[3];dictionary[1]=q->args[4];used=0;prepared=1;
    }else if(q->operation==RPC_RMTOPERATIONS_APPEND){
        if(!prepared||!n||q->args[0]!=used||n>bytes-used){fail(RPC_STATUS_BAD_ARGUMENT,RPC_PERIPHERALERRORS_BAD_SEQUENCE);goto done;}
        const uint8_t *p=(const void *)(q+1);for(unsigned i=0;i<n;i++)data[used++]=p[i];reply.values[0]=used;
    }else if(q->operation==RPC_RMTOPERATIONS_SEND){if(n)fail(RPC_STATUS_BAD_LENGTH,0);else send(q);
    }else if(q->operation==RPC_RMTOPERATIONS_ABORT){hw_rmt_stop(channel);prepared=used=0;
    }else fail(RPC_STATUS_UNSUPPORTED,0);
done:
    rpc_send(&reply,sizeof(reply));return 1;
}
#else
uint32_t rpc_rmt_capabilities(void){return 0;}
int rpc_rmt_handle(const rpc_header_t *r,uint32_t n){(void)r;(void)n;return 0;}
#endif
