# ตั้งค่า Neural Superhuman ด้วย KataGo

ระดับ `Neural Superhuman` ใช้ [KataGo](https://github.com/lightvector/KataGo)
ผ่าน [JSON Analysis Engine protocol](https://github.com/lightvector/KataGo/blob/master/docs/Analysis_Engine.md)
จริง ทั้งโหมดผู้เล่นปะทะ AI และ AI ปะทะ AI

ระบบจะไม่เปิดให้เลือกระดับนี้ถ้ายังไม่ได้ตั้งค่าเอนจิน และถ้าเอนจินหลุดกลางเกม
เซิร์ฟเวอร์จะใช้ AI สำรองเพื่อไม่ให้เกมค้าง พร้อมแสดงป้าย `AI · FALLBACK`
ในหน้า Control อย่างชัดเจน

> ไม่มีเอนจินใดรับรองคำว่า “เก่งที่สุดในจักรวาล” ได้ตามตัวอักษร
> ความเก่งจริงขึ้นกับไฟล์ neural net, จำนวน visits และ GPU ที่ใช้
> ควรใช้ network ล่าสุด/แข็งที่สุดจาก [KataGo Training](https://katagotraining.org/)

## วิธี A — เรียก KataGo ผ่าน HTTPS (แนะนำสำหรับ Vercel)

ตั้ง Environment Variables:

```env
KATAGO_API_URL=https://your-katago-service.example/analyze
KATAGO_API_KEY=replace-with-a-secret
KATAGO_MAX_VISITS=1600
KATAGO_ROOT_SYMMETRIES=8
KATAGO_TIMEOUT_MS=20000
KATAGO_RETRY_COOLDOWN_MS=30000
```

Endpoint ต้อง:

1. รับ `POST` พร้อม `Content-Type: application/json`
2. ตรวจ `Authorization: Bearer <KATAGO_API_KEY>` ถ้ากำหนดคีย์
3. รับ body เป็น KataGo analysis query โดยตรง
4. ตอบ analysis result โดยตรง หรือห่อด้วย `{ "result": ... }`

ตัวอย่าง response ขั้นต่ำ:

```json
{
  "id": "same-id-from-request",
  "isDuringSearch": false,
  "moveInfos": [
    { "move": "D4", "order": 0, "visits": 1600, "winrate": 0.61, "scoreLead": 2.4 }
  ]
}
```

Vercel เหมาะกับวิธีนี้เพราะ Function เรียก HTTPS ได้โดยไม่ต้องบรรจุ binary และ
neural net ขนาดใหญ่ไว้ใน deployment ซึ่งมี
[bundle limit](https://vercel.com/docs/functions/limitations)
และทรัพยากร CPU/GPU ไม่เหมาะกับ KataGo ระดับสูง

## วิธี B — รัน KataGo process บนเครื่องเดียวกับเกม

เหมาะกับ Node Web Service แบบ long-running เช่น Render, VPS หรือเครื่องที่มี GPU
ดาวน์โหลด KataGo binary, analysis config และ neural net ก่อน แล้วตั้งค่า:

```env
KATAGO_BIN=/opt/katago/katago
KATAGO_MODEL=/opt/katago/model.bin.gz
KATAGO_CONFIG=/opt/katago/analysis.cfg
KATAGO_MAX_VISITS=1600
KATAGO_ROOT_SYMMETRIES=8
KATAGO_TIMEOUT_MS=20000
KATAGO_RETRY_COOLDOWN_MS=30000
```

ระบบจะเปิด process รูปแบบเดียวกับคำสั่งทางการนี้และค้างไว้เพื่อรับหลายเกม:

```bash
./katago analysis -model /opt/katago/model.bin.gz -config /opt/katago/analysis.cfg
```

ห้ามตั้ง `KATAGO_API_URL` พร้อมวิธี B เพราะ remote URL มีลำดับความสำคัญสูงกว่า
local process

## ค่าความแรง

- `KATAGO_MAX_VISITS` — ยิ่งสูงยิ่งอ่านลึก แต่ช้าลงและใช้ GPU มากขึ้น
- `KATAGO_ROOT_SYMMETRIES` — ค่า `8` ให้ KataGo เฉลี่ยสมมาตรครบทั้งแปดแบบที่ root
- `KATAGO_TIMEOUT_MS` — เวลารอสูงสุดต่อตา ควรต่ำกว่าเวลาของ AI ในนาฬิกา
- `KATAGO_RETRY_COOLDOWN_MS` — เวลาพักก่อนลอง endpoint ใหม่หลังเกิดข้อผิดพลาด

ค่าเริ่มต้นคือ 1,600 visits, 8 symmetries และ timeout 20 วินาที
ถ้ามี GPU แรงและต้องการเพิ่มความแข็ง ให้เพิ่ม visits พร้อมเพิ่มเวลานาฬิกาให้พอ

## ตรวจหลังดีพลอย

1. หน้า Player ต้องขึ้น `KataGo Neural ตั้งค่าแล้ว`
2. ตัวเลือก `🧠 Neural Superhuman` ต้องไม่เป็นสีเทา
3. เริ่ม User vs AI แล้วหน้า Control ต้องเปลี่ยนป้ายจาก `AI · กำลังคิด`
   เป็น `AI · NEURAL`
4. เริ่ม AI vs AI โดยเลือก Neural Superhuman ทั้งดำและขาว แล้วตรวจว่าทั้งสองฝั่ง
   มีป้าย neural
5. ถ้าป้ายเป็น `AI · FALLBACK` ให้ดู server log ที่ขึ้นต้นด้วย `[neural-ai]`
