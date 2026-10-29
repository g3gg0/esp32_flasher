/* One LL adapter for all chips with physical RMT. C2/C61 have no RMT. */
#if STUB_HAS_RMT
#include "rmt_port.h"
#include "platform.h"
#include "sdkconfig.h"
#include "hal/rmt_ll.h"
#include "hal/rmt_periph.h"
#include "hal/clk_tree_ll.h"
#include "soc/soc_caps.h"
enum { __DECLARE_RCC_ATOMIC_ENV=1 };
extern uint32_t RMTMEM;
static unsigned requested_hz,idle_level;
static uint32_t source_hz(void){
#if CONFIG_IDF_TARGET_ESP32 || CONFIG_IDF_TARGET_ESP32S2
    uint32_t hz=clk_ll_apb_load_freq_hz();return hz>=1000000&&hz<=80000000?hz:80000000;
#elif CONFIG_IDF_TARGET_ESP32H2
    return 32000000;
#else
    return 40000000;
#endif
}
unsigned hw_rmt_count(void){return RMT_LL_TX_CANDIDATES_PER_INST;}
unsigned hw_rmt_words(void){return SOC_RMT_MEM_WORDS_PER_CHANNEL;}
void hw_rmt_info(unsigned channel,uint32_t v[8]){
    v[0]=soc_rmt_signals[0].channels[channel].tx_sig;v[1]=hw_rmt_count();v[2]=hw_rmt_words();v[3]=4096;v[4]=source_hz();v[5]=3;v[6]=v[7]=0;
}
uint32_t hw_rmt_config(unsigned channel,unsigned hz,unsigned idle){
    uint32_t src=source_hz(),cpu=platform_ticks_per_us()*1000000u,best=0,error=UINT32_MAX,divider=0;
    for(unsigned d=1;d<=256;d++)if(!(src%d)){
        uint32_t f=src/d,e=f>hz?f-hz:hz-f;
        if(f&&!(cpu%f)&&e<error){error=e;best=f;divider=d;}
    }
    if(!best)return 0;
    requested_hz=hz;idle_level=idle;
    rmt_ll_enable_bus_clock(0,true);rmt_ll_reset_register(0);rmt_ll_enable_periph_clock(&RMT,true);
#if CONFIG_IDF_TARGET_ESP32 || CONFIG_IDF_TARGET_ESP32S2
    rmt_ll_set_group_clock_src(&RMT,channel,RMT_CLK_SRC_APB,1,1,0);
#else
    rmt_ll_set_group_clock_src(&RMT,channel,RMT_CLK_SRC_XTAL,1,1,0);
#endif
    rmt_ll_enable_group_clock(&RMT,true);rmt_ll_mem_force_power_on(&RMT);rmt_ll_enable_mem_access_nonfifo(&RMT,true);
    rmt_ll_enable_interrupt(&RMT,UINT32_MAX,false);rmt_ll_clear_interrupt_status(&RMT,UINT32_MAX);
    rmt_ll_tx_set_channel_clock_div(&RMT,channel,divider);rmt_ll_tx_set_mem_blocks(&RMT,channel,1);
    rmt_ll_tx_enable_loop(&RMT,channel,false);rmt_ll_tx_enable_wrap(&RMT,channel,true);
    rmt_ll_tx_enable_carrier_modulation(&RMT,channel,false);rmt_ll_tx_fix_idle_level(&RMT,channel,idle,true);
#if SOC_RMT_SUPPORT_DMA
    rmt_ll_tx_enable_dma(&RMT,channel,false);
#endif
    rmt_ll_tx_set_limit(&RMT,channel,hw_rmt_words()/2);rmt_ll_tx_reset_pointer(&RMT,channel);return best;
}
void hw_rmt_prepare(unsigned channel){hw_rmt_stop(channel);rmt_ll_tx_reset_pointer(&RMT,channel);rmt_ll_clear_interrupt_status(&RMT,UINT32_MAX);}
void hw_rmt_write(unsigned channel,unsigned offset,uint32_t word){((volatile uint32_t *)&RMTMEM)[channel*SOC_RMT_MEM_WORDS_PER_CHANNEL+offset]=word;}
void hw_rmt_start(unsigned channel){rmt_ll_tx_start(&RMT,channel);}
unsigned hw_rmt_events(unsigned channel){
    uint32_t raw=rmt_ll_tx_get_interrupt_status_raw(&RMT,channel);
    return ((raw&RMT_LL_EVENT_TX_DONE(channel))?1:0)|((raw&RMT_LL_EVENT_TX_THRES(channel))?2:0)|((RMT.int_raw.val&RMT_LL_EVENT_TX_ERROR(channel))?4:0);
}
void hw_rmt_clear(unsigned channel,unsigned events){uint32_t mask=0;if(events&1)mask|=RMT_LL_EVENT_TX_DONE(channel);if(events&2)mask|=RMT_LL_EVENT_TX_THRES(channel);if(events&4)mask|=RMT_LL_EVENT_TX_ERROR(channel);rmt_ll_clear_interrupt_status(&RMT,mask);}
void hw_rmt_stop(unsigned channel){
#if RMT_LL_SUPPORT(ASYNC_STOP)
    rmt_ll_tx_stop(&RMT,channel);
#else
    /* Classic ESP32 has no asynchronous stop. A peripheral reset is bounded
     * even if the current symbol is very long; restore our sole TX channel. */
    hw_rmt_config(channel,requested_hz,idle_level);
#endif
    rmt_ll_clear_interrupt_status(&RMT,UINT32_MAX);
}
void hw_rmt_release(unsigned channel){hw_rmt_stop(channel);rmt_ll_enable_group_clock(&RMT,false);rmt_ll_enable_periph_clock(&RMT,false);rmt_ll_enable_bus_clock(0,false);}
#endif
