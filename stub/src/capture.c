/* Bounded device-side GPIO bank and ADC sweep. Configuration is uploaded once;
 * each scan returns every selected value with device-relative timestamps. */
#include "capture.h"
#include "platform.h"
#include "sdmmc.h"
#include "adc_calibration.h"
#if defined(STUB_HAS_PERIPHERALS) || defined(RPC_CAPTURE_TEST)
#include <stdbool.h>
static rpc_capture_plan_t plans[24];
static uint32_t configured, banks[4];
static unsigned bank_count;
static int last_slot = -1;
typedef struct __attribute__((packed)) { uint16_t pin, kind; uint32_t value, offset_us; } sample_t;
_Static_assert(sizeof(sample_t) == 12, "capture result wire size");
static struct { rpc_capture_response_t header; sample_t samples[24]; } reply;
#ifdef RPC_CAPTURE_TEST
uint32_t capture_read(uint32_t address);
void capture_write(uint32_t address, uint32_t value, uint32_t mask);
#else
uint32_t capture_read(uint32_t address) { return *(volatile uint32_t *)(uintptr_t)address; }
void capture_write(uint32_t address, uint32_t value, uint32_t mask) {
    volatile uint32_t *p=(void *)(uintptr_t)address;
    *p=mask==UINT32_MAX?value:(*p&~mask)|(value&mask);
}
#endif
static bool valid(uint32_t address, int write) { return address && !(address&3) && platform_register_allowed(address,write); }
static bool wait_bits(uint32_t address,uint32_t mask,bool asserted) {
    uint32_t start=platform_cycles(),budget=5000u*platform_ticks_per_us();
    do { if (!!(capture_read(address)&mask)==asserted) return true; } while ((uint32_t)(platform_cycles()-start)<budget);
    return false;
}
static bool conversion(const rpc_capture_plan_t *p,uint32_t *value) {
    if(p->idle_mask&&!wait_bits(p->idle_addr,p->idle_mask,false))return false;
    for(unsigned i=0;i<3;i++) {
        capture_write(p->steps[i*3],p->steps[i*3+1],p->steps[i*3+2]);
        if(i==0&&p->low_us)platform_delay(p->low_us);
    }
    if(!wait_bits(p->wait_addr,p->wait_mask,true))return false;
    if(p->data_delay_us)platform_delay(p->data_delay_us);
    uint32_t raw=capture_read(p->data_addr);
    if(raw&p->invalid_mask)return false;
    *value=raw&p->data_mask;return true;
}
uint32_t rpc_capture_capabilities(void) { return 1u<<RPC_CAPABILITIES_CAPTURE; }
int rpc_capture_handle(const rpc_header_t *request,uint32_t length) {
    if(request->magic[0]!='I'||request->magic[1]!='O'||request->magic[2]!='C'||request->magic[3]!='C')return 0;
    reply.header=(rpc_capture_response_t){0};
    reply.header.header.magic[0]='I';reply.header.header.magic[1]='O';reply.header.header.magic[2]='C';reply.header.header.magic[3]='R';
    reply.header.failed_slot=0xffff;
    uint32_t start=platform_cycles(),ticks=platform_ticks_per_us();if(!ticks)ticks=1;
    if(length<sizeof(rpc_capture_command_t)){reply.header.status=RPC_STATUS_BAD_LENGTH;goto done;}
    const rpc_capture_command_t *q=(const void *)request;
    if(q->operation==RPC_CAPTUREOPERATIONS_ADC_INITIALIZE) {
        uint32_t codes[2],version=0;
        reply.header.status=capture_adc_initialize(request,length,codes,&version);reply.header.detail=version;
        if(!reply.header.status){const rpc_adc_setup_t *p=(const void *)request;for(unsigned u=0;u<p->unit_count;u++){sample_t *s=&reply.samples[reply.header.count++];s->pin=p->units[u*19];s->kind=2;s->value=codes[u];s->offset_us=0;}}
    } else if(q->operation==RPC_CAPTUREOPERATIONS_ADC_CONFIGURE) {
        if(length!=sizeof(rpc_capture_plan_t)){reply.header.status=RPC_STATUS_BAD_LENGTH;goto done;}
        const rpc_capture_plan_t *p=(const void *)request;
        bool ok=p->slot<24&&p->pin<128&&p->flags==0&&p->low_us<=100&&p->data_delay_us<=100&&p->data_mask&&p->wait_mask;
        for(unsigned i=0;i<3;i++)ok=ok&&valid(p->steps[i*3],1);
        ok=ok&&valid(p->wait_addr,0)&&valid(p->data_addr,0)&&(!p->idle_mask||valid(p->idle_addr,0))&&valid(p->cleanup_addr,1);
        if(!ok){reply.header.status=RPC_STATUS_BAD_ARGUMENT;goto done;}
        plans[p->slot]=*p;configured|=1u<<p->slot;last_slot=-1;
    } else if(q->operation==RPC_CAPTUREOPERATIONS_GPIO_CONFIGURE) {
        if(q->count>4||length!=sizeof(*q)+q->count*4u){reply.header.status=RPC_STATUS_BAD_LENGTH;goto done;}
        const uint32_t *addresses=(const void *)(q+1);
        for(unsigned i=0;i<q->count;i++)if(!valid(addresses[i],0)){reply.header.status=RPC_STATUS_BAD_ARGUMENT;goto done;}
        bank_count=q->count;for(unsigned i=0;i<bank_count;i++)banks[i]=addresses[i];
    } else if(length!=sizeof(*q))reply.header.status=RPC_STATUS_BAD_LENGTH;
    else if(q->operation==RPC_CAPTUREOPERATIONS_RELEASE){reply.header.status=capture_adc_release();configured=0;bank_count=0;last_slot=-1;}
    else if(q->operation==RPC_CAPTUREOPERATIONS_ADC_RELEASE){reply.header.status=capture_adc_release();configured=0;last_slot=-1;}
    else if(q->operation==RPC_CAPTUREOPERATIONS_GPIO_SCAN) {
        if(q->selection&~((1u<<bank_count)-1u)){reply.header.status=RPC_STATUS_BAD_ARGUMENT;goto done;}
        for(unsigned i=0;i<bank_count;i++)if(q->selection&(1u<<i)){
            sample_t *s=&reply.samples[reply.header.count++];s->pin=i;s->kind=0;s->value=capture_read(banks[i]);s->offset_us=(uint32_t)(platform_cycles()-start)/ticks;
        }
    } else if(q->operation==RPC_CAPTUREOPERATIONS_ADC_SCAN) {
        if(!capture_adc_ready()){reply.header.status=RPC_STATUS_BAD_ARGUMENT;goto done;}
        if(q->selection&~configured){reply.header.status=RPC_STATUS_BAD_ARGUMENT;goto done;}
        for(unsigned i=0;i<24;i++)if(q->selection&(1u<<i)) {
            const rpc_capture_plan_t *p=&plans[i];uint32_t value=0;
            bool ok=last_slot==(int)i||conversion(p,&value);
            uint32_t began=platform_cycles();
            if(ok)ok=conversion(p,&value);
            if(!ok){capture_write(p->cleanup_addr,0,p->cleanup_mask);last_slot=-1;reply.header.status=RPC_STATUS_TIMEOUT;reply.header.failed_slot=i;reply.header.count=0;goto done;}
            last_slot=i;sample_t *s=&reply.samples[reply.header.count++];s->pin=p->pin;s->kind=1;s->value=value;
            s->offset_us=(uint32_t)(began-start)/ticks+(uint32_t)(platform_cycles()-began)/ticks/2;
        }
    } else reply.header.status=RPC_STATUS_UNSUPPORTED;
done:
    reply.header.duration_us=(uint32_t)(platform_cycles()-start)/ticks;
    reply.header.header.length=sizeof(reply.header)+reply.header.count*sizeof(sample_t);
    rpc_send(&reply,reply.header.header.length);return 1;
}
#else
uint32_t rpc_capture_capabilities(void) {return 0;}
int rpc_capture_handle(const rpc_header_t *p,uint32_t size){(void)p;(void)size;return 0;}
#endif
