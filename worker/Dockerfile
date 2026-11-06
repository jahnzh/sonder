FROM python:3.10-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak libespeak-dev gcc g++ make && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir 'numpy==1.26.4' 'setuptools<70' 'wheel' && pip install --no-cache-dir 'aeneas==1.7.3' 'fastapi==0.121.3' 'uvicorn==0.38.0' 'psutil==7.1.3'
RUN pip install --no-cache-dir 'faster-whisper==1.2.1'
COPY requirements-ctc.txt /worker/requirements-ctc.txt
RUN pip install --no-cache-dir -r /worker/requirements-ctc.txt
WORKDIR /worker
COPY align.py align_task.py anchors.py ctc_acoustic.py ctc_path.py ctc_pipeline.py deadline.py download_model.py pipeline.py /worker/
ENV PYTHONUNBUFFERED=1 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2
EXPOSE 3012
CMD ["uvicorn", "align:app", "--host", "0.0.0.0", "--port", "3012", "--no-access-log"]
