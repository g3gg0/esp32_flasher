#include <stdint.h>
#include <stdlib.h>
#include <string.h>
static uint32_t regs[1024],conversions;
static uint8_t analog[256];
static int initialized;
static uint32_t clock_us;
static int c6_reset_seen;
void capture_test_delay(uint32_t us){clock_us+=us;}
uint32_t capture_test_cycles(void){return clock_us+=1;}
static int mode(const char *name){const char *m=getenv("CAPTURE_TEST_MODE");return m&&!strcmp(m,name);}
static void init(void){if(initialized)return;initialized=1;memset(analog,0xa5,sizeof(analog));regs[0]=0x12345678;regs[1]=0x89abcdef;regs[0x300/4]=mode("old-version")?0:1;regs[0x304/4]=0xc0000000;regs[0x308/4]=0x55;regs[0x400/4]=0xa5a5a5a5;regs[0x500/4]=32;regs[0x504/4]=32;regs[0x518/4]=0x80008800;regs[0x600/4]=0x80;regs[0x604/4]=0x40;regs[0x608/4]=0x0c000123;}
static uint32_t remap(uint32_t a){return a==0x600af018?0x60000600:a==0x600af01c?0x60000604:a==0x600b0154?0x60000608:a==0x600af010?0x60000614:a;}
static int c6_ready(void){return !mode("c6-cold")||((regs[0x600/4]&4)&&(regs[0x604/4]&4)&&(regs[0x614/4]&1)&&(regs[0x608/4]&0x0c000000)==0x0c000000&&c6_reset_seen&&regs[0x60c/4]==0xfffdff);}
uint32_t capture_read(uint32_t address){init();address=remap(address);if(address==0x6000051c)return (regs[0x504/4]&32)?regs[0x500/4]:((regs[0x518/4]&256)?32:0);if(address==0x60000210)return analog[0];if(address==0x60000214)return analog[1];return regs[(address-0x60000000)/4];}
void capture_write(uint32_t address,uint32_t value,uint32_t mask){
    init();address=remap(address);if(address==0x60000608&&!(value&(1u<<26))&&(mask&(1u<<26)))c6_reset_seen=1;
    if((address==0x60000200||address==0x60000204)&&(!c6_ready()||(mode("c6-cold")&&((value&(1u<<26))||address!=0x60000200u+((regs[0x610/4]&(1u<<11))?0:4)))))return;
    unsigned i=(address-0x60000000)/4;regs[i]=(regs[i]&~mask)|(value&mask);
    if(address==0x60000508)regs[0x500/4]|=value;
    if(address==0x6000050c)regs[0x500/4]&=~value;
    if(address==0x60000510)regs[0x504/4]|=value;
    if(address==0x60000514)regs[0x504/4]&=~value;
    if(address==0x60000104){regs[0x108/4]&=~value;return;}
    if(address==0x60000100){
        if(!(regs[i]&1))regs[0x108/4]=0;
        else if(!mode("timeout")){conversions++;regs[0x108/4]=16;regs[0x10c/4]=0x100+conversions;}
    }
    if(address==0x60000200||address==0x60000204){
        unsigned reg=value>>8&255;
        if((value&(1u<<24))&&!mode("ignored-write"))analog[reg]=value>>16&255;
        regs[i]=(value&~(0xffu<<16))|((uint32_t)analog[reg]<<16);
        if(mode("busy"))regs[i]|=1u<<25;
    }
}
