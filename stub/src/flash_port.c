/* ROM flash driver, shared across ESP32 targets; no heap, cache or IDF runtime. */
#if STUB_HAS_FLASH
#include "flash_port.h"
#include "platform.h"
#include "esp_rom_spiflash.h"
#include "esp_rom_efuse.h"
#include "soc/soc.h"
#include "soc/gpio_reg.h"
#if CONFIG_IDF_TARGET_ESP32
#include "soc/spi_reg.h"
extern esp_rom_spiflash_chip_t g_rom_spiflash_chip;
#define g_rom_flashchip g_rom_spiflash_chip
#define COMMAND SPI_CMD_REG(1)
#define READ_ID SPI_FLASH_RDID
#define DATA SPI_W0_REG(1)
#else
#include "soc/spi_mem_reg.h"
#if CONFIG_IDF_TARGET_ESP32P4
#include "soc/hp_sys_clkrst_reg.h"
/* IDF's ROM entry addresses stay stable, but ECO5 moved ROM globals by
 * 512 KiB. Select their slots from the revision-independent ROM header. */
static esp_rom_spiflash_legacy_data_t *p4_flash_context(void){
    uint32_t eco=*(const volatile uint32_t *)0x4fc00014u;
    uintptr_t slot=eco>=5?0x4ffbffe8u:0x4ff3ffe8u;
    return (esp_rom_spiflash_legacy_data_t *)(uintptr_t)*(volatile uint32_t *)slot;
}
#undef g_rom_flashchip
#define g_rom_flashchip (p4_flash_context()->chip)
#define COMMAND SPI1_MEM_C_CMD_REG
#define READ_ID SPI1_MEM_C_FLASH_RDID
#define DATA SPI1_MEM_C_W0_REG
#else
#define COMMAND SPI_MEM_CMD_REG(1)
#define READ_ID SPI_MEM_FLASH_RDID
#define DATA SPI_MEM_W0_REG(1)
#endif
#endif
#if CONFIG_IDF_TARGET_ESP32S3
/* Exported ROM entry; IDF's public efuse header omits this query. */
extern bool ets_efuse_flash_octal_mode(void);
#endif
extern esp_rom_spiflash_result_t esp_rom_spiflash_unlock(void);
unsigned hw_flash_probe_step(unsigned step,uint32_t *id,uint32_t *size,uint32_t *status,uint32_t context[4]){
    if(step==0){
#if CONFIG_IDF_TARGET_ESP32S3
        if(ets_efuse_flash_octal_mode())return 3;
#endif
#if CONFIG_IDF_TARGET_ESP32P4
        uint32_t eco=*(const volatile uint32_t *)0x4fc00014u;
        context[0]=(uint32_t)(uintptr_t)p4_flash_context();
        context[1]=*(volatile uint32_t *)(uintptr_t)(eco>=5?0x4ffbffecu:0x4ff3ffecu);
        context[2]=REG_READ(HP_SYS_CLKRST_PERI_CLK_CTRL00_REG);
        context[3]=REG_READ(HP_SYS_CLKRST_HP_RST_EN0_REG);
        /* No normal IDF boot has run. Never dereference a missing ROM context. */
        if(context[0]<0x4ff00000u||context[0]>0x4fffffd0u||!context[1])return 4;
#else
        for(unsigned i=0;i<4;i++)context[i]=0;
#endif
        return 0;
    }
    if(step==1){
#if CONFIG_IDF_TARGET_ESP32P4
        /* Cold ROM download need not leave the external-PLL flash path usable.
         * Supply the flash controller from XTAL (40 MHz), with its own core
         * divider at 1; attach subsequently selects a conservative SCLK. */
        REG_CLR_BIT(HP_SYS_CLKRST_HP_RST_EN0_REG,HP_SYS_CLKRST_REG_RST_EN_MSPI_APB|HP_SYS_CLKRST_REG_RST_EN_MSPI_AXI);
        REG_SET_BIT(HP_SYS_CLKRST_SOC_CLK_CTRL0_REG,HP_SYS_CLKRST_REG_FLASH_SYS_CLK_EN);
        REG_SET_BIT(HP_SYS_CLKRST_PERI_CLK_CTRL00_REG,HP_SYS_CLKRST_REG_FLASH_PLL_CLK_EN|HP_SYS_CLKRST_REG_FLASH_CORE_CLK_EN);
        REG_SET_FIELD(HP_SYS_CLKRST_PERI_CLK_CTRL00_REG,HP_SYS_CLKRST_REG_FLASH_CLK_SRC_SEL,0);
        REG_SET_FIELD(HP_SYS_CLKRST_PERI_CLK_CTRL00_REG,HP_SYS_CLKRST_REG_FLASH_CORE_CLK_DIV_NUM,0);
#endif
    uint32_t pins=0;
#if CONFIG_IDF_TARGET_ESP32 || CONFIG_IDF_TARGET_ESP32S2 || CONFIG_IDF_TARGET_ESP32S3
    pins=esp_rom_efuse_get_flash_gpio_info();
#endif
#if CONFIG_IDF_TARGET_ESP32
    if(!pins&&(REG_READ(GPIO_STRAP_REG)&0x1c)==8)pins=1;
#endif
    esp_rom_spiflash_attach(pins,false);
        return 0;
    }
    if(step==2)return esp_rom_spiflash_config_readmode(ESP_ROM_SPIFLASH_SLOWRD_MODE);
    if(step==3){
    REG_WRITE(DATA,0);REG_WRITE(COMMAND,READ_ID);
    uint32_t start=platform_cycles(),budget=platform_ticks_per_us()*100000u;
    while(REG_READ(COMMAND)&READ_ID)if((uint32_t)(platform_cycles()-start)>budget)return 2;
    *id=REG_READ(DATA)&0xffffff;
    unsigned exponent=*id>>16;*size=exponent>=12&&exponent<=30?1u<<exponent:0;
        return 0;
    }
    if(!*size||!*id||*id==0xffffff)return 0;
    if(step==4)return esp_rom_spiflash_config_param(*id,*size>0x1000000?0x1000000:*size,65536,4096,256,0xffff);
    if(step==5)return esp_rom_spiflash_read_status(&g_rom_flashchip,status);
    return 1;
}
unsigned hw_flash_probe(uint32_t *id,uint32_t *size,uint32_t *status){
    uint32_t context[4];
    for(unsigned step=0;step<6;step++){unsigned r=hw_flash_probe_step(step,id,size,status,context);if(r)return r;}
    return 0;
}
unsigned hw_flash_read(uint32_t address,uint32_t *data,unsigned length){return esp_rom_spiflash_read(address,data,length);}
unsigned hw_flash_write(uint32_t address,const uint32_t *data,unsigned length){unsigned r=esp_rom_spiflash_unlock();return r?r:esp_rom_spiflash_write(address,data,length);}
unsigned hw_flash_erase(uint32_t address){unsigned r=esp_rom_spiflash_unlock();return r?r:esp_rom_spiflash_erase_sector(address/4096);}
#endif
