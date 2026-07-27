# วิธีนำโปรเจกต์ขึ้น Vercel

ZIP นี้เตรียม `server.js` และ `vercel.json` สำหรับ Vercel Node.js Function
ไว้แล้ว รวมถึง WebSocket ที่เกมใช้สื่อสารแบบเรียลไทม์

ต้นฉบับมาจาก `solorecord81993/gop2p` สาขา `main`

## วิธีนำขึ้น

1. แตกไฟล์ ZIP โดยให้ `package.json`, `server.js` และ `vercel.json`
   อยู่ที่โฟลเดอร์ชั้นแรก
2. เลือกวิธีใดวิธีหนึ่ง:
   - อัปโหลดโฟลเดอร์นี้เข้า GitHub แล้วเลือก **Vercel → Add New → Project**
   - หรือเปิด Terminal ในโฟลเดอร์ แล้วรัน `npx vercel` จากนั้นรัน
     `npx vercel --prod`
3. ถ้า Vercel ถาม Framework Preset ให้เลือก **Other**
   และใช้ Root Directory เป็นโฟลเดอร์นี้
4. เพิ่ม Environment Variables ตามตารางด้านล่าง แล้ว Redeploy

| ชื่อ | จำเป็น | ตัวอย่าง / หน้าที่ |
|---|---:|---|
| `DIRECTOR_TOKEN` | ใช่ | รหัสลับสำหรับหน้า `/director` |
| `SUPABASE_URL` | แนะนำ | URL ของ Supabase project |
| `SUPABASE_SERVICE_KEY` | แนะนำ | Supabase `service_role` key; ห้ามเผยแพร่ฝั่ง browser |
| `AI_DELAY_MS` | ไม่ | `600` — เวลาคิดของ AI ต่อหนึ่งตา |
| `AI_RESULT_HOLD_MS` | ไม่ | `60000` — ค้างสรุปผล AI 1 นาทีก่อนปิดห้อง |
| `KATAGO_API_URL` | ถ้าจะใช้ Neural | HTTPS endpoint ของ KataGo Analysis Engine |
| `KATAGO_API_KEY` | แนะนำ | Bearer key ของ KataGo endpoint |
| `KATAGO_MAX_VISITS` | ไม่ | `1600` — จำนวน visits ของ Neural Superhuman |
| `KATAGO_ROOT_SYMMETRIES` | ไม่ | `8` — เฉลี่ยสมมาตรที่ root ครบแปดแบบ |
| `KATAGO_TIMEOUT_MS` | ไม่ | `20000` — timeout ต่อตา |
| `GROQ_API_KEY` | ไม่ | ใช้กับเสียงพากย์ MC |
| `OPENROUTER_API_KEY` | ไม่ | ใช้กับเสียงพากย์ MC |
| `MC_LANG` | ไม่ | `th`, `en` หรือ `ja` |

หลัง deploy ให้ตรวจ:

- `/healthz` ต้องตอบสถานะปกติ
- `/director` ต้องเข้าได้ด้วยค่า `DIRECTOR_TOKEN`
- `/live` ต้องเปิดหน้าออกอากาศได้
- ถ้าใส่ `KATAGO_API_URL` แล้ว ตัวเลือก `Neural Superhuman` ต้องไม่เป็นสีเทา

ดูสัญญา request/response ของ endpoint และวิธีใช้ local KataGo process ใน
[`KATAGO-SETUP.md`](KATAGO-SETUP.md) `Dockerfile` ที่แถม KataGo มาให้มีไว้สำหรับ
Render/container host เท่านั้น Vercel จะไม่ build หรือรัน Dockerfile นี้ และไม่ควร
บรรจุ binary กับ neural net ขนาดใหญ่ลง Vercel Function โดยตรง

## ข้อจำกัดของ Vercel ที่ควรรู้

ตัวเกมเก็บห้องที่กำลังเล่นไว้ในหน่วยความจำของ server instance และใช้ WebSocket
แบบเชื่อมต่อต่อเนื่อง จึงเหมาะกับการทดลองหรือผู้ใช้พร้อมกันไม่มากบน Vercel
หาก Function ถูกรีสตาร์ต ปรับสเกล หรือถึงเวลาทำงานสูงสุด การเชื่อมต่ออาจหลุดและ
ห้องที่ยังไม่จบอาจหายได้ สำหรับงานถ่ายทอดจริงต่อเนื่อง ควรใช้ Node Web Service
แบบ long-running (เช่น Render ตาม `render.yaml`) หรือย้าย room state ไปยัง
ระบบเก็บสถานะส่วนกลางก่อน
