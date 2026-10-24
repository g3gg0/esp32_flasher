/* ADC clocks, factory trim decoding, analog-I2C setup and restoration are
 * device-side. The browser supplies bounded chip register descriptors only. */
#include "adc_calibration.h"
#include "platform.h"
#include <stdbool.h>
#if defined(STUB_HAS_PERIPHERALS) || defined(RPC_CAPTURE_TEST)
uint32_t capture_read(uint32_t address);
void capture_write(uint32_t address,uint32_t value,uint32_t mask);
static struct {uint32_t address,value,mask;} saved[24];
static struct {uint8_t reg,value,mask;} analog[16];
static unsigned saved_count,analog_count;
static uint32_t bus,command_mask,block;
unsigned capture_adc_ready(void){return bus&&saved_count;}
static bool valid(uint32_t a,int write){return a&&!(a&3)&&platform_register_allowed(a,write);}
static bool idle(void){uint32_t start=platform_cycles(),limit=5000u*platform_ticks_per_us();do{if(!(capture_read(bus)&(1u<<25)))return true;}while((uint32_t)(platform_cycles()-start)<limit);return false;}
static bool ar(unsigned reg,uint32_t *value){if(!idle())return false;capture_write(bus,block|(reg<<8)|command_mask,UINT32_MAX);if(!idle())return false;*value=capture_read(bus)>>16&255;return true;}
static bool aw(unsigned reg,uint32_t value){if(!idle())return false;capture_write(bus,block|(reg<<8)|((value&255)<<16)|(1u<<24)|command_mask,UINT32_MAX);return idle();}
static bool aset(unsigned reg,uint32_t value,uint32_t mask){
    uint32_t old;if(!ar(reg,&old))return false;
    unsigned i;for(i=0;i<analog_count;i++)if(analog[i].reg==reg)break;
    if(i==analog_count){if(analog_count==16)return false;analog_count++;analog[i].reg=reg;analog[i].value=0;analog[i].mask=0;}
    unsigned fresh=mask&~analog[i].mask;analog[i].value|=old&fresh;analog[i].mask|=mask;
    if(!aw(reg,(old&~mask)|(value&mask))||!ar(reg,&old))return false;
    return (old&mask)==(value&mask);
}
static bool set(uint32_t a,uint32_t value,uint32_t mask){
    unsigned i;for(i=0;i<saved_count;i++)if(saved[i].address==a)break;
    if(i==saved_count){if(saved_count==24)return false;saved_count++;saved[i].address=a;saved[i].value=0;saved[i].mask=0;}
    uint32_t fresh=mask&~saved[i].mask;if(fresh)saved[i].value|=capture_read(a)&fresh;saved[i].mask|=mask;
    capture_write(a,value,mask);return true;
}
static bool efuse(uint32_t address,unsigned shift,unsigned bits,uint32_t *value){
    if(!bits||bits>16||shift>31||!valid(address,0)||(shift+bits>32&&!valid(address+4,0)))return false;
    uint64_t raw=capture_read(address);if(shift+bits>32)raw|=(uint64_t)capture_read(address+4)<<32;
    *value=(raw>>shift)&((1u<<bits)-1);return true;
}
unsigned capture_adc_release(void){
    bool ok=true;
    while(analog_count){unsigned i=--analog_count;uint32_t old;if(!ar(analog[i].reg,&old)||!aw(analog[i].reg,(old&~analog[i].mask)|(analog[i].value&analog[i].mask)))ok=false;}
    while(saved_count){unsigned i=--saved_count;capture_write(saved[i].address,saved[i].value,saved[i].mask);}
    bus=0;return ok?RPC_STATUS_OK:RPC_STATUS_IO_ERROR;
}
unsigned capture_adc_initialize(const rpc_header_t *request,uint32_t length,uint32_t codes[2],uint32_t *version){
    if(length<sizeof(rpc_adc_setup_t))return RPC_STATUS_BAD_LENGTH;
    const rpc_adc_setup_t *p=(const void *)request;
    if(saved_count||analog_count)return RPC_STATUS_BAD_ARGUMENT;
    if(p->init_count>20||p->analog_count>12||!p->unit_count||p->unit_count>2||length!=sizeof(*p)+12u*(p->init_count+p->analog_count)||p->block>255||!valid(p->bus_control,1)||!valid(p->bus_control+4,1)||(p->bus_select&&!valid(p->bus_select,0)))return RPC_STATUS_BAD_ARGUMENT;
    const uint32_t *ops=(const void *)(p+1);
    for(unsigned i=0;i<p->init_count;i++)if(!valid(ops[i*3],1))return RPC_STATUS_BAD_ARGUMENT;
    for(unsigned i=p->init_count;i<p->init_count+p->analog_count;i++)if(ops[i*3]>255||ops[i*3+1]>255||ops[i*3+2]>255)return RPC_STATUS_BAD_ARGUMENT;
    uint32_t major,minor=0;
    if(!efuse(p->major[0],p->major[1],p->major[2],&major)||(p->minor_multiplier&&!efuse(p->minor[0],p->minor[1],p->minor[2],&minor)))return RPC_STATUS_BAD_ARGUMENT;
    *version=major*(p->minor_multiplier?p->minor_multiplier:1)+minor;
    if((p->version_exact&&*version!=p->version_min)||(!p->version_exact&&*version<p->version_min))return RPC_STATUS_BAD_ARGUMENT;
    for(unsigned u=0;u<p->unit_count;u++){
        unsigned k=u*19,n=p->units[k+2];uint32_t code=p->units[k+1],part;
        if(!n||n>4||p->units[k+15]>255||p->units[k+16]>255||p->units[k+17]>255||p->units[k+18]>255)return RPC_STATUS_BAD_ARGUMENT;
        for(unsigned j=0;j<n;j++){if(!efuse(p->units[k+3+j*3],p->units[k+4+j*3],p->units[k+5+j*3],&part))return RPC_STATUS_BAD_ARGUMENT;code+=part;}
        if(code>4095)return RPC_STATUS_BAD_ARGUMENT;
        codes[u]=code;
    }
    for(unsigned i=0;i<p->init_count;i++)if(!set(ops[i*3],ops[i*3+1],ops[i*3+2]))goto failed;
    bus=p->bus_control;command_mask=p->bus_command_mask;block=p->block;
    if(p->bus_select&&!(capture_read(p->bus_select)&p->bus_select_mask))bus+=4;
    for(unsigned i=p->init_count;i<p->init_count+p->analog_count;i++)if(!aset(ops[i*3],ops[i*3+1],ops[i*3+2]))goto failed;
    for(unsigned u=0;u<p->unit_count;u++){unsigned k=u*19;if(!aset(p->units[k+15],codes[u]>>8,p->units[k+16])||!aset(p->units[k+17],codes[u]&255,p->units[k+18]))goto failed;}
    platform_delay(2000);return RPC_STATUS_OK;
failed:
    capture_adc_release();return RPC_STATUS_IO_ERROR;
}
#else
unsigned capture_adc_ready(void){return 0;}
unsigned capture_adc_release(void){return RPC_STATUS_OK;}
unsigned capture_adc_initialize(const rpc_header_t *p,uint32_t n,uint32_t c[2],uint32_t *v){(void)p;(void)n;(void)c;(void)v;return RPC_STATUS_UNSUPPORTED;}
#endif
