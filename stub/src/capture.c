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
typedef struct __attribute__((packed)) { uint16_t mean_q4; uint32_t actual_delay_ns; } step_sample_t;
static union {
    struct { rpc_capture_response_t header; sample_t samples[24]; } capture;
    struct { rpc_step_response_t header; step_sample_t samples[RPC_STEPRESPONSE_MAXRECORDS]; } step;
} responses;
#define reply responses.capture
#define step_reply responses.step
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
static bool conversion_timed(const rpc_capture_plan_t *p,uint32_t *value,uint32_t *started,uint32_t *finished) {
    if(p->idle_mask&&!wait_bits(p->idle_addr,p->idle_mask,false))return false;
    for(unsigned i=0;i<3;i++) {
        capture_write(p->steps[i*3],p->steps[i*3+1],p->steps[i*3+2]);
        if(i==2&&started)*started=platform_cycles();
        if(i==0&&p->low_us)platform_delay(p->low_us);
    }
    if(!wait_bits(p->wait_addr,p->wait_mask,true))return false;
    if(p->data_delay_us)platform_delay(p->data_delay_us);
    uint32_t raw=capture_read(p->data_addr);
    if(finished)*finished=platform_cycles();
    if(raw&p->invalid_mask)return false;
    *value=raw&p->data_mask;return true;
}
static bool conversion(const rpc_capture_plan_t *p,uint32_t *value){return conversion_timed(p,value,0,0);}
uint32_t rpc_capture_capabilities(void) { return 1u<<RPC_CAPABILITIES_CAPTURE; }
static int step_response(const rpc_header_t *request,uint32_t length) {
    rpc_step_response_t *r=&step_reply.header;
    *r=(rpc_step_response_t){0};r->header=(rpc_header_t){{'S','T','P','R'},sizeof(*r)};
    uint32_t ticks=platform_ticks_per_us();if(!ticks)ticks=1;
    uint32_t began=platform_cycles(),delays[RPC_STEPRESPONSE_MAXPOINTS],count=0,total=0,modes=0;
    if(length!=sizeof(rpc_step_command_t)){r->status=RPC_STATUS_BAD_LENGTH;goto done;}
    const rpc_step_command_t *q=(const void *)request;
    r->pin=q->pin;r->mode_mask=q->mode_mask;r->min_delay_ns=q->min_delay_ns;
    r->max_delay_us=q->max_delay_us;r->settle_us=q->settle_us;r->repetitions=q->repetitions;
    r->measurement=q->slot==0xffff?0:1;
    if(q->pin>=128||q->bit_mask!=(1u<<(q->pin&31))||!q->mode_mask||(q->mode_mask&~31u)||
        !q->repetitions||q->repetitions>RPC_STEPRESPONSE_MAXREPETITIONS||!q->max_delay_us||q->max_delay_us>1000000||q->settle_us>1000000||
        !q->min_delay_ns||q->min_delay_ns>q->max_delay_us*1000u){r->status=RPC_STATUS_BAD_ARGUMENT;goto done;}
    if(q->slot!=0xffff&&(q->slot>=24||!(configured&(1u<<q->slot))||plans[q->slot].pin!=q->pin||!capture_adc_ready())){r->status=RPC_STATUS_BAD_ARGUMENT;goto done;}
    uint32_t addresses[]={q->mux_addr,q->output_addr,q->enable_addr,q->enable_set_addr,q->enable_clear_addr,q->set_addr,q->clear_addr,q->input_addr};
    for(unsigned i=0;i<8;i++)if(!valid(addresses[i],i==0||(i>=3&&i<=6))){r->status=RPC_STATUS_BAD_ARGUMENT;goto done;}
    for(uint32_t d=q->min_delay_ns;;d*=2){
        if(count==RPC_STEPRESPONSE_MAXPOINTS){r->status=RPC_STATUS_BAD_ARGUMENT;goto done;}
        uint32_t ns=d<q->max_delay_us*1000u?d:q->max_delay_us*1000u;
        delays[count++]=ns;total+=(ns+999)/1000;
        if(ns==q->max_delay_us*1000u)break;
    }
    for(unsigned m=0;m<5;m++)if(q->mode_mask&(1u<<m))modes++;
    if((uint64_t)(q->settle_us*count+total)*q->repetitions*modes*2>RPC_STEPRESPONSE_MAXDURATIONUS){r->status=RPC_STATUS_BAD_ARGUMENT;goto done;}
    r->point_count=count;
    uint32_t bit=q->bit_mask,mux_mask=q->pull_up|q->pull_down|(3u<<10);
    uint32_t saved_mux=capture_read(q->mux_addr),saved_enable=capture_read(q->enable_addr)&bit,saved_output=capture_read(q->output_addr)&bit;
    const rpc_capture_plan_t *p=q->slot==0xffff?0:&plans[q->slot];
    for(unsigned direction=0;direction<2&&!r->status;direction++)for(unsigned mode=0;mode<5&&!r->status;mode++)if(q->mode_mask&(1u<<mode)) {
        for(unsigned point=0;point<count&&!r->status;point++){
            uint32_t sum=0;uint64_t times=0;
            uint32_t delay_ticks=(uint32_t)(((uint64_t)delays[point]*ticks+999)/1000);
            for(unsigned repeat=0;repeat<q->repetitions;repeat++){
                uint32_t value=0;
                capture_write(q->enable_clear_addr,bit,UINT32_MAX);
                capture_write(q->mux_addr,3u<<10,mux_mask);
                capture_write(direction?q->clear_addr:q->set_addr,bit,UINT32_MAX);
                capture_write(q->enable_set_addr,bit,UINT32_MAX);
                if(p&&!conversion(p,&value)){r->status=RPC_STATUS_TIMEOUT;break;}
                platform_delay(q->settle_us);
                if(mode)capture_write(q->mux_addr,(mode-1u)<<10,mux_mask);
                else capture_write(q->mux_addr,direction?q->pull_up:q->pull_down,mux_mask);
                capture_write(mode?(direction?q->set_addr:q->clear_addr):q->enable_clear_addr,bit,UINT32_MAX);
                uint32_t edge=platform_cycles();
                while((uint32_t)(platform_cycles()-edge)<delay_ticks){}
                uint32_t start=platform_cycles();
                uint32_t end;
                if(p){if(!conversion_timed(p,&value,&start,&end)){r->status=RPC_STATUS_TIMEOUT;break;}}
                else {value=!!(capture_read(q->input_addr)&bit);end=platform_cycles();}
                sum+=value;times+=(uint64_t)((start-edge)+(end-start)/2)*1000/ticks;
                if((uint32_t)(end-began)/ticks>RPC_STEPRESPONSE_MAXDURATIONUS){r->status=RPC_STATUS_TIMEOUT;break;}
            }
            if(!r->status){step_sample_t *s=&step_reply.samples[r->sample_count++];s->mean_q4=(sum*16u+q->repetitions/2)/q->repetitions;s->actual_delay_ns=(uint32_t)(times/q->repetitions);}
        }
    }
    capture_write(q->enable_clear_addr,bit,UINT32_MAX);
    capture_write(q->mux_addr,saved_mux,mux_mask);
    capture_write(saved_output?q->set_addr:q->clear_addr,bit,UINT32_MAX);
    if(saved_enable)capture_write(q->enable_set_addr,bit,UINT32_MAX);
    if(p){capture_write(p->cleanup_addr,0,p->cleanup_mask);last_slot=-1;}
    if(r->status)r->sample_count=0;
done:
    r->duration_us=(uint32_t)(platform_cycles()-began)/ticks;
    r->header.length=sizeof(*r)+r->sample_count*sizeof(step_sample_t);
    rpc_send(&step_reply,r->header.length);return 1;
}
int rpc_capture_handle(const rpc_header_t *request,uint32_t length) {
    if(request->magic[0]=='S'&&request->magic[1]=='T'&&request->magic[2]=='P'&&request->magic[3]=='C')return step_response(request,length);
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
        if(reply.header.status)reply.header.failed_slot=capture_adc_failure_slot();
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
