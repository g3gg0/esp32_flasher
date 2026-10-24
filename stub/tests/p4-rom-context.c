/* Run the actual P4 adapter against mapped ROM/RAM slots and IDF headers. */
#define _GNU_SOURCE
#include <assert.h>
#include <sys/mman.h>
#include <stdint.h>
#include <stdio.h>
#include "esp_rom_spiflash.h"
#include "soc/hp_sys_clkrst_reg.h"
#include "flash_port.h"
static esp_rom_spiflash_chip_t *expected;
static void map_page(uintptr_t address){void *p=(void *)(address&~4095u);assert(mmap(p,4096,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED,-1,0)==p);}
void esp_rom_spiflash_attach(uint32_t p,bool b){(void)p;(void)b;}
esp_rom_spiflash_result_t esp_rom_spiflash_config_readmode(esp_rom_spiflash_read_mode_t m){(void)m;return 0;}
esp_rom_spiflash_result_t esp_rom_spiflash_config_param(uint32_t a,uint32_t b,uint32_t c,uint32_t d,uint32_t e,uint32_t f){(void)a;(void)b;(void)c;(void)d;(void)e;(void)f;return 0;}
esp_rom_spiflash_result_t esp_rom_spiflash_read_status(esp_rom_spiflash_chip_t *chip,uint32_t *status){assert(chip==expected);assert(chip->device_id==0x1640ef);*status=0x42;return 0;}
esp_rom_spiflash_result_t esp_rom_spiflash_read(uint32_t a,uint32_t *b,int32_t c){(void)a;(void)b;(void)c;return 0;}
esp_rom_spiflash_result_t esp_rom_spiflash_write(uint32_t a,const uint32_t *b,int32_t c){(void)a;(void)b;(void)c;return 0;}
esp_rom_spiflash_result_t esp_rom_spiflash_unlock(void){return 0;}
esp_rom_spiflash_result_t esp_rom_spiflash_erase_sector(uint32_t a){(void)a;return 0;}
uint32_t platform_cycles(void){return 0;}
uint32_t platform_ticks_per_us(void){return 40;}
int main(void){
    map_page(0x4fc00000);map_page(0x4ff3ffe8);map_page(0x4ffbffe8);map_page(0x4ff10000);
    map_page(HP_SYS_CLKRST_PERI_CLK_CTRL00_REG);map_page(HP_SYS_CLKRST_HP_RST_EN0_REG);
    expected=(void *)0x4ff10000;expected->device_id=0x1640ef;
    for(unsigned eco=0;eco<=6;eco++){
        *(uint32_t *)0x4fc00014=eco;
        *(uint32_t *)0x4ff3ffe8=eco>=5?0xdbab813b:0x4ff10000;
        *(uint32_t *)0x4ff3ffec=eco>=5?0xb990764b:0x4fc10000;
        *(uint32_t *)0x4ffbffe8=eco>=5?0x4ff10000:0xdbab813b;
        *(uint32_t *)0x4ffbffec=eco>=5?0x4fc10000:0xb990764b;
        uint32_t id=0x1640ef,size=4194304,status=0,context[4];
        assert(hw_flash_probe_step(0,&id,&size,&status,context)==0);
        assert(context[0]==0x4ff10000&&context[1]==0x4fc10000);
        assert(hw_flash_probe_step(5,&id,&size,&status,context)==0&&status==0x42);
    }
    *(uint32_t *)0x4ffbffe8=0xdbab813b;
    uint32_t id=0,size=0,status=0,context[4];assert(hw_flash_probe_step(0,&id,&size,&status,context)==4);
    puts("P4 actual adapter: ECO0-4 and ECO5+ use correct ROM slots, status receives correct descriptor; invalid context rejected.");
}
