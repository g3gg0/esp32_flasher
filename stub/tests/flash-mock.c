#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "flash_port.h"
static uint8_t memory[131072];
static int initialized;
unsigned hw_flash_probe(uint32_t *id,uint32_t *size,uint32_t *status){
    if(!initialized){memset(memory,255,sizeof(memory));initialized=1;}
    *id=getenv("NO_FLASH")?0xffffff:0x1140ef;*size=sizeof(memory);*status=0;return 0;
}
unsigned hw_flash_read(uint32_t address,uint32_t *data,unsigned length){if(address+length>sizeof(memory))abort();memcpy(data,memory+address,length);return 0;}
unsigned hw_flash_probe_step(unsigned step,uint32_t *id,uint32_t *size,uint32_t *status,uint32_t context[4]){(void)step;for(unsigned i=0;i<4;i++)context[i]=0;return hw_flash_probe(id,size,status);}
unsigned hw_flash_write(uint32_t address,const uint32_t *data,unsigned length){if(address+length>sizeof(memory))abort();for(unsigned i=0;i<length;i++)memory[address+i]&=((const uint8_t *)data)[i];return 0;}
unsigned hw_flash_erase(uint32_t address){if(address%4096||address+4096>sizeof(memory))abort();memset(memory+address,255,4096);return 0;}
