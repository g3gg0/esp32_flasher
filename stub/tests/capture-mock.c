#include <stdint.h>
#include <stdlib.h>
#include <string.h>
static uint32_t regs[1024],conversions;
static uint8_t analog[256];
static int initialized;
static int mode(const char *name){const char *m=getenv("CAPTURE_TEST_MODE");return m&&!strcmp(m,name);}
static void init(void){if(initialized)return;initialized=1;memset(analog,0xa5,sizeof(analog));regs[0]=0x12345678;regs[1]=0x89abcdef;regs[0x300/4]=mode("old-version")?0:1;regs[0x304/4]=0xc0000000;regs[0x308/4]=0x55;regs[0x400/4]=0xa5a5a5a5;}
uint32_t capture_read(uint32_t address){init();if(address==0x60000210)return analog[0];if(address==0x60000214)return analog[1];return regs[(address-0x60000000)/4];}
void capture_write(uint32_t address,uint32_t value,uint32_t mask){
    init();unsigned i=(address-0x60000000)/4;regs[i]=(regs[i]&~mask)|(value&mask);
    if(address==0x60000104){regs[0x108/4]&=~value;return;}
    if(address==0x60000100){
        if(!(regs[i]&1))regs[0x108/4]=0;
        else if(!mode("timeout")){conversions++;regs[0x108/4]=16;regs[0x10c/4]=0x100+conversions;}
    }
    if(address==0x60000200||address==0x60000204){
        unsigned reg=value>>8&255;
        if(value&(1u<<24))analog[reg]=value>>16&255;
        regs[i]=(value&~(0xffu<<16))|((uint32_t)analog[reg]<<16);
        if(mode("busy"))regs[i]|=1u<<25;
    }
}
