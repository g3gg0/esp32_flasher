#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include "rmt_port.h"
#include "rmt_clock.h"
static uint32_t mem[64],time_ticks,sent,read_at;
static uint32_t actual_hz;
static uint64_t rmt_ticks;
static unsigned ready,finished;
static int mode(const char *s){const char *m=getenv("RMT_MODE");return m&&!strcmp(m,s);}
uint32_t rmt_test_cpu_us(void){const char *s=getenv("RMT_CPU_US");return s?atoi(s):1;}
uint32_t hw_rmt_cpu_hz(void){const char *s=getenv("RMT_CPU_HZ");return s?(uint32_t)strtoul(s,0,10):rmt_test_cpu_us()*1000000u;}
uint32_t rmt_test_cycles(void){return time_ticks;}
unsigned hw_rmt_count(void){return 2;}
unsigned hw_rmt_words(void){const char *s=getenv("RMT_WORDS");return s?atoi(s):8;}
void hw_rmt_info(unsigned ch,uint32_t v[8]){(void)ch;for(unsigned i=0;i<8;i++)v[i]=0;v[1]=2;v[2]=hw_rmt_words();v[3]=4096;}
uint32_t hw_rmt_config(unsigned ch,unsigned hz,unsigned idle){
    (void)ch;(void)idle;const char *s=getenv("RMT_SOURCE_HZ");uint32_t source=s?atoi(s):40000000;
    unsigned divider=rmt_clock_divider(source,hz);return actual_hz=divider?source/divider:0;
}
void hw_rmt_prepare(unsigned ch){(void)ch;memset(mem,0,sizeof(mem));sent=read_at=ready=finished=0;rmt_ticks=0;time_ticks=0;}
void hw_rmt_write(unsigned ch,unsigned offset,uint32_t word){(void)ch;if(offset>=hw_rmt_words())abort();mem[offset]=word;}
void hw_rmt_start(unsigned ch){(void)ch;ready=1;}
static uint32_t expected(unsigned index){
    const char *s=getenv("RMT_EXPECT");if(!s)return 0;
    if(getenv("RMT_BITS")){
        const char *data=getenv("RMT_BITS");char b[3]={data[(index/8)*2],data[(index/8)*2+1],0};unsigned bit=(strtoul(b,0,16)>>(7-index%8))&1;
        char w[9];memcpy(w,s+bit*8,8);w[8]=0;return strtoul(w,0,16);
    }
    char w[9];memcpy(w,s+index*8,8);w[8]=0;return strtoul(w,0,16);
}
unsigned hw_rmt_events(unsigned ch){
    (void)ch;if(!ready)abort();
    if(mode("timeout")){time_ticks+=1000*rmt_test_cpu_us();return 0;}if(mode("error"))return 4;
    uint32_t w=mem[read_at];
    if(!w){finished=1;return 1;}
    const char *n=getenv("RMT_COUNT");if(n&&w!=expected(sent%(unsigned)atoi(n))){fprintf(stderr,"RMT stream mismatch at %u\n",sent);abort();}
    sent++;rmt_ticks+=(w&32767)+((w>>16)&32767);
    time_ticks=rmt_ticks*hw_rmt_cpu_hz()/actual_hz;
    read_at=(read_at+1)%hw_rmt_words();
    if(!(read_at%(hw_rmt_words()/2))){if(mode("underrun"))time_ticks+=100000*rmt_test_cpu_us();return 2;}
    return 0;
}
void hw_rmt_clear(unsigned ch,unsigned event){(void)ch;(void)event;}
void hw_rmt_stop(unsigned ch){(void)ch;ready=0;if(finished&&getenv("RMT_TOTAL")&&sent!=(unsigned)atoi(getenv("RMT_TOTAL")))abort();}
void hw_rmt_release(unsigned ch){hw_rmt_stop(ch);}
