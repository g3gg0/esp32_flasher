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
unsigned hw_flash_probe(uint32_t *id,uint32_t *size,uint32_t *status){
#if CONFIG_IDF_TARGET_ESP32S3
    if(ets_efuse_flash_octal_mode())return 3;
#endif
    uint32_t pins=0;
#if CONFIG_IDF_TARGET_ESP32 || CONFIG_IDF_TARGET_ESP32S2 || CONFIG_IDF_TARGET_ESP32S3
    pins=esp_rom_efuse_get_flash_gpio_info();
#endif
#if CONFIG_IDF_TARGET_ESP32
    if(!pins&&(REG_READ(GPIO_STRAP_REG)&0x1c)==8)pins=1;
#endif
    esp_rom_spiflash_attach(pins,false);
    unsigned r=esp_rom_spiflash_config_readmode(ESP_ROM_SPIFLASH_SLOWRD_MODE);if(r)return r;
    REG_WRITE(DATA,0);REG_WRITE(COMMAND,READ_ID);
    uint32_t start=platform_cycles(),budget=platform_ticks_per_us()*100000u;
    while(REG_READ(COMMAND)&READ_ID)if((uint32_t)(platform_cycles()-start)>budget)return 2;
    *id=REG_READ(DATA)&0xffffff;
    unsigned exponent=*id>>16;*size=exponent>=12&&exponent<=30?1u<<exponent:0;
    if(!*size||!*id||*id==0xffffff)return 0;
    r=esp_rom_spiflash_config_param(*id,*size>0x1000000?0x1000000:*size,65536,4096,256,0xffff);if(r)return r;
    return esp_rom_spiflash_read_status(&g_rom_flashchip,status);
}
unsigned hw_flash_read(uint32_t address,uint32_t *data,unsigned length){return esp_rom_spiflash_read(address,data,length);}
unsigned hw_flash_write(uint32_t address,const uint32_t *data,unsigned length){unsigned r=esp_rom_spiflash_unlock();return r?r:esp_rom_spiflash_write(address,data,length);}
unsigned hw_flash_erase(uint32_t address){unsigned r=esp_rom_spiflash_unlock();return r?r:esp_rom_spiflash_erase_sector(address/4096);}
#endif
