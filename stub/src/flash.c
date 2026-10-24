/* Shared, bounded flash operations. No flash initialization during startup. */
#include "flash.h"
#include "flash_port.h"
#include "sdmmc.h"
#if STUB_HAS_FLASH || defined(RPC_FLASH_TEST)
static struct { rpc_peripheral_response_t reply; uint32_t data[192]; } packet;
static uint32_t capacity;
static unsigned ready;
static void fail(unsigned status,unsigned error){packet.reply.status=status;packet.reply.error=error;}
static int result(unsigned r){if(r)fail(r==2?RPC_STATUS_TIMEOUT:RPC_STATUS_IO_ERROR,RPC_FLASHERRORS_ROM);return !r;}
uint32_t rpc_flash_capabilities(void){return 1u<<RPC_CAPABILITIES_FLASH;}
int rpc_flash_handle(const rpc_header_t *request,uint32_t length){
    if(request->magic[0]!='F'||request->magic[1]!='L'||request->magic[2]!='A'||request->magic[3]!='C')return 0;
    packet.reply=(rpc_peripheral_response_t){0};
    packet.reply.header=(rpc_header_t){{'F','L','A','R'},sizeof(packet.reply)};
    if(length<sizeof(rpc_peripheral_command_t)){fail(RPC_STATUS_BAD_LENGTH,0);goto done;}
    const rpc_peripheral_command_t *q=(const void *)request;
    packet.reply.operation=q->operation;packet.reply.port=q->port;
    unsigned n=length-sizeof(*q);uint32_t address=q->args[0],count=q->args[1];
    if(q->port){fail(RPC_STATUS_BAD_ARGUMENT,0);goto done;}
    if(q->operation==RPC_FLASHOPERATIONS_INFO){
        if(n){fail(RPC_STATUS_BAD_LENGTH,0);goto done;}
        uint32_t id=0,size=0,status=0;ready=0;capacity=0;
        unsigned r=hw_flash_probe(&id,&size,&status);
        if(r==3){fail(RPC_STATUS_UNSUPPORTED,RPC_FLASHERRORS_UNSUPPORTED_MODE);goto done;}
        if(!result(r))goto done;
        if(!id||id==0xffffff||size<4096){fail(RPC_STATUS_IO_ERROR,RPC_FLASHERRORS_NO_DEVICE);goto done;}
        capacity=size>0x1000000?0x1000000:size;ready=1;
        uint32_t v[8]={id,size,4096,256,768,status,capacity,1};
        for(unsigned i=0;i<8;i++)packet.reply.values[i]=v[i];
        goto done;
    }
    if(!ready){fail(RPC_STATUS_IO_ERROR,RPC_FLASHERRORS_NO_DEVICE);goto done;}
    if(!count||address>=capacity||count>capacity-address){fail(RPC_STATUS_BAD_ARGUMENT,RPC_FLASHERRORS_RANGE);goto done;}
    if(q->operation==RPC_FLASHOPERATIONS_ERASE){
        if(n||count!=4096||(address&4095)){fail(RPC_STATUS_BAD_ARGUMENT,RPC_FLASHERRORS_ALIGNMENT);goto done;}
        if(result(hw_flash_erase(address)))packet.reply.values[0]=4096;
        goto done;
    }
    if(q->operation!=RPC_FLASHOPERATIONS_READ&&q->operation!=RPC_FLASHOPERATIONS_WRITE&&q->operation!=RPC_FLASHOPERATIONS_CHECK&&q->operation!=RPC_FLASHOPERATIONS_VERIFY){fail(RPC_STATUS_UNSUPPORTED,0);goto done;}
    if((address&3)||(count&3)){fail(RPC_STATUS_BAD_ARGUMENT,RPC_FLASHERRORS_ALIGNMENT);goto done;}
    unsigned has_data=q->operation==RPC_FLASHOPERATIONS_WRITE||q->operation==RPC_FLASHOPERATIONS_VERIFY;
    if((has_data?n!=count:n!=0)||count>(q->operation==RPC_FLASHOPERATIONS_CHECK?65536u:sizeof(packet.data))||(q->operation==RPC_FLASHOPERATIONS_WRITE&&count>256)){
        fail(RPC_STATUS_BAD_LENGTH,0);goto done;
    }
    const uint8_t *source=(const void *)(q+1);uint32_t crc=~0u,first=UINT32_MAX;
    for(unsigned offset=0;offset<count;){
        unsigned chunk=count-offset;if(chunk>sizeof(packet.data))chunk=sizeof(packet.data);
        if(!result(hw_flash_read(address+offset,packet.data,chunk)))goto done;
        uint8_t *bytes=(void *)packet.data;
        if(has_data)for(unsigned i=0;i<chunk;i++){
            if(q->operation==RPC_FLASHOPERATIONS_VERIFY&&bytes[i]!=source[i]){
                packet.reply.values[1]=address+i;packet.reply.values[2]=bytes[i];fail(RPC_STATUS_IO_ERROR,RPC_FLASHERRORS_VERIFY);goto done;
            }
            if(q->operation==RPC_FLASHOPERATIONS_WRITE&&(bytes[i]&source[i])!=source[i]){
                packet.reply.values[1]=address+i;fail(RPC_STATUS_IO_ERROR,RPC_FLASHERRORS_NEEDS_ERASE);goto done;
            }
        }
        if(q->operation==RPC_FLASHOPERATIONS_READ){packet.reply.header.length+=chunk;packet.reply.values[0]=chunk;goto done;}
        if(q->operation==RPC_FLASHOPERATIONS_CHECK)for(unsigned i=0;i<chunk;i++){
            if(bytes[i]!=255&&first==UINT32_MAX)first=address+offset+i;
            crc^=bytes[i];for(unsigned bit=0;bit<8;bit++)crc=(crc>>1)^(0xedb88320u&-(crc&1));
        }
        offset+=chunk;
    }
    if(q->operation==RPC_FLASHOPERATIONS_WRITE){
        for(unsigned i=0;i<count;i++)((uint8_t *)packet.data)[i]=source[i];
        if(!result(hw_flash_write(address,packet.data,count)))goto done;
    }
    packet.reply.values[0]=count;
    if(q->operation==RPC_FLASHOPERATIONS_CHECK){packet.reply.values[1]=crc^~0u;packet.reply.values[2]=first;}
done:
    rpc_send(&packet,packet.reply.header.length);return 1;
}
#else
uint32_t rpc_flash_capabilities(void){return 0;}
int rpc_flash_handle(const rpc_header_t *q,uint32_t n){(void)q;(void)n;return 0;}
#endif
